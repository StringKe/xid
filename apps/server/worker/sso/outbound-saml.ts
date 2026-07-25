// Outbound SAML IdP:XID 给下游 SaaS SP 发 signed SAML Response。
// 与 inbound `/sso/saml/:connection/*` 分离,避免把 XID 作为 SP 和 IdP 的角色混用。

import { envelopeDecrypt, toBufferSource } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import {
  buildIdpMetadataXml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  signLogoutRequest,
  signLogoutResponse,
  signSamlResponse,
  verifySamlLogoutRequest,
  verifySamlLogoutResponse,
} from '@xid-kit/saml'
import type { SamlAttributeValue } from '@xid-kit/saml'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { revokeSession } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'
import {
  peekOutboundSamlSessionsForUser,
  resolveOutboundSamlSessionIndex,
  trackOutboundSamlSession,
} from './saml-do'
import { decodeKek } from '../oidc/shared'
import { resolveSamlServiceProviderTenant, withTenant } from './tenant'
import {
  assertUserPassesAssignmentGate,
  parseAssignmentGate,
  withoutAssignmentGate,
} from './assignment-gate'

type SamlServiceProvider = typeof schema.samlServiceProviders.$inferSelect
type CertRow = typeof schema.certStore.$inferSelect
type UserRow = typeof schema.users.$inferSelect

const outbound = new Hono<XidHonoEnv>()
const DEFAULT_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'

function requiredParam(c: Context<XidHonoEnv>, name: string): string {
  const value = c.req.param(name)
  if (!value) throw new AppError('invalid_request', { httpStatus: 400 })
  return value
}

function idpEntityId(c: Context<XidHonoEnv>, appId: string): string {
  return `${c.get('tenant').issuer}/sso/outbound/saml/${encodeURIComponent(appId)}`
}

function idpSsoUrl(c: Context<XidHonoEnv>, appId: string): string {
  return `${c.get('tenant').issuer}/sso/outbound/saml/${encodeURIComponent(appId)}/sso`
}

function idpSloUrl(c: Context<XidHonoEnv>, appId: string): string {
  return `${c.get('tenant').issuer}/sso/outbound/saml/${encodeURIComponent(appId)}/slo`
}

async function resolveSp(c: Context<XidHonoEnv>, appId: string): Promise<SamlServiceProvider> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.samlServiceProviders.findOne(eq(schema.samlServiceProviders.id, appId))
  if (!row) throw new AppError('connection_not_found', { httpStatus: 404 })
  return row
}

async function loadSigningCert(c: Context<XidHonoEnv>, sp: SamlServiceProvider): Promise<CertRow> {
  if (!sp.idpSigningCertId) throw new AppError('connection_not_found', { httpStatus: 404 })
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const cert = await db.certStore.findOne(
    and(
      eq(schema.certStore.id, sp.idpSigningCertId),
      eq(schema.certStore.usage, 'saml_idp_signing'),
      eq(schema.certStore.status, 'active'),
    ),
  )
  if (!cert) throw new AppError('connection_not_found', { httpStatus: 404 })
  return cert
}

async function importSamlSigningKey(cert: CertRow, kekB64: string): Promise<CryptoKey> {
  const pkcs8 = await envelopeDecrypt(
    {
      iv: new Uint8Array(cert.privateKeyIv),
      ciphertext: new Uint8Array(cert.privateKeyCiphertext),
      tag: new Uint8Array(cert.privateKeyTag),
      kekVersion: cert.kekVersion,
      kid: cert.id,
      alg: 'RS256',
    },
    decodeKek(kekB64),
  )
  const key = await crypto.subtle.importKey(
    'pkcs8',
    toBufferSource(pkcs8),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  pkcs8.fill(0)
  return key
}

async function readAuthenticatedUser(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<UserRow> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await db.users.findOne(
    and(eq(schema.users.id, session.userId), eq(schema.users.status, 'active')),
  )
  if (!user) throw new AppError('invalid_credentials', { httpStatus: 401 })
  if (session.activeOrgId) {
    const membership = await db.memberships.findOne(
      and(
        eq(schema.memberships.userId, session.userId),
        eq(schema.memberships.orgId, session.activeOrgId),
        eq(schema.memberships.status, 'active'),
      ),
    )
    if (!membership) throw new AppError('access_denied', { httpStatus: 403 })
  }
  return user
}

async function primaryEmail(c: Context<XidHonoEnv>, user: UserRow): Promise<string> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  if (user.primaryEmailId) {
    const row = await db.userEmails.findOne(eq(schema.userEmails.id, user.primaryEmailId))
    if (row?.email) return row.email
  }
  const first = await db.userEmails.findOne(eq(schema.userEmails.userId, user.id))
  if (first?.email) return first.email
  if (user.username) return user.username
  throw new AppError('invalid_request', { httpStatus: 400 })
}

function readMappingString(
  mapping: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = mapping[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function userAttributes(
  sp: SamlServiceProvider,
  user: UserRow,
  email: string,
): Record<string, SamlAttributeValue> {
  const mapping = withoutAssignmentGate(sp.attributeMapping as Record<string, unknown>)
  const firstName = user.firstName ?? ''
  const lastName = user.lastName ?? ''
  const displayName = user.displayName ?? [firstName, lastName].filter(Boolean).join(' ')
  const out: Record<string, SamlAttributeValue> = {
    [readMappingString(mapping, 'email', 'email')]: email,
    [readMappingString(mapping, 'userEmail', 'User.Email')]: email,
  }
  if (firstName) out[readMappingString(mapping, 'firstName', 'firstName')] = firstName
  if (lastName) out[readMappingString(mapping, 'lastName', 'lastName')] = lastName
  if (displayName) out[readMappingString(mapping, 'displayName', 'displayName')] = displayName
  return out
}

function base64Xml(value: string): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(value.trim()), (ch) => ch.charCodeAt(0)),
    )
  } catch {
    return null
  }
}

function authnRequestId(xml: string | null): string | undefined {
  if (!xml) return undefined
  const match = /\sID="([^"]+)"/.exec(xml)
  return match?.[1]
}

function samlRequestFromQuery(c: Context<XidHonoEnv>): string | null {
  const queryValue = c.req.query('SAMLRequest')
  return queryValue ? base64Xml(queryValue) : null
}

function relayStateFromRequest(c: Context<XidHonoEnv>, formValue?: string | null): string | null {
  const value = formValue ?? c.req.query('RelayState') ?? c.req.query('relay_state')
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 2048) : null
}

function loginRedirect(c: Context<XidHonoEnv>): Response {
  const url = new URL(`${c.get('tenant').issuer}/sign-in`)
  url.searchParams.set('continue', new URL(c.req.url).pathname)
  return c.redirect(url.toString(), 302)
}

function postBindingForm(input: {
  destination: string
  samlMessage: string
  fieldName: 'SAMLRequest' | 'SAMLResponse'
  relayState: string | null
}): string {
  const relay = input.relayState
    ? `<input type="hidden" name="RelayState" value="${htmlEscape(input.relayState)}">`
    : ''
  return [
    `<!doctype html>`,
    `<html><body>`,
    `<form method="post" action="${htmlEscape(input.destination)}">`,
    `<input type="hidden" name="${input.fieldName}" value="${htmlEscape(input.samlMessage)}">`,
    relay,
    `</form>`,
    `<script>document.forms[0].submit()</script>`,
    `</body></html>`,
  ].join('')
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function auditSloFailure(
  c: Context<XidHonoEnv>,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await Promise.resolve(
      c.env.AUDIT_QUEUE.send({
        tenantId: c.get('tenant').tenantId,
        action: 'saml.slo_failed',
        actorId: undefined,
        ts: Date.now(),
        payload,
      }),
    )
  } catch {
    // best-effort observability
  }
}

async function revokeOutboundBinding(
  c: Context<XidHonoEnv>,
  binding: { userId: string; sessionId: string },
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.sessions.findOne(eq(schema.sessions.id, binding.sessionId))
  if (!row || row.userId !== binding.userId || row.status !== 'active') return
  const session: SessionData = {
    sessionId: row.id,
    userId: row.userId,
    status: 'active',
    activeOrgId: row.activeOrgId ?? null,
    authenticatedAt: row.authenticatedAt,
    lastActiveAt: row.lastActiveAt,
    expiresAt: row.expiresAt,
    rememberMe: row.rememberMe,
    isImpersonation: row.isImpersonation,
    impersonatorUserId: row.impersonatorUserId ?? null,
    acr: row.acr ?? null,
    amr: row.amr ?? null,
    aal: row.aal ?? null,
  }
  await revokeSession(c, session)
}

// SLO 消息:SAMLRequest 与 SAMLResponse 二选一(至少其一),Signature/SigAlg 仅 redirect 验签用。
// 形状失败按 malformed_request 400(协议错误格式),不走 validation_failed,故用 safeParse 自映射。
const outboundSloMessageSchema = v.pipe(
  v.object({
    SAMLRequest: v.optional(v.pipe(v.string(), v.minLength(1))),
    SAMLResponse: v.optional(v.pipe(v.string(), v.minLength(1))),
    RelayState: v.optional(v.string()),
    Signature: v.optional(v.string()),
    SigAlg: v.optional(v.string()),
  }),
  v.check(
    (input) => input.SAMLRequest !== undefined || input.SAMLResponse !== undefined,
    'SAMLRequest or SAMLResponse required',
  ),
)

async function readOutboundSloMessage(c: Context<XidHonoEnv>): Promise<{
  kind: 'request' | 'response'
  encoded: string
  binding: 'post' | 'redirect'
  relayState: string | null
  redirectSignature?: {
    samlRequestEncoded: string
    relayState?: string | null
    signature: string
    sigAlg: string
  }
}> {
  const isPost = c.req.method === 'POST'
  // FormData 值可能是 File,交给 schema 拒绝,故输入按 unknown 收集。
  let input: Record<string, unknown>
  if (isPost) {
    const form = await c.req.formData()
    input = {
      SAMLRequest: form.get('SAMLRequest') ?? undefined,
      SAMLResponse: form.get('SAMLResponse') ?? undefined,
      RelayState: form.get('RelayState') ?? undefined,
    }
  } else {
    input = {
      SAMLRequest: c.req.query('SAMLRequest'),
      SAMLResponse: c.req.query('SAMLResponse'),
      RelayState: c.req.query('RelayState'),
      Signature: c.req.query('Signature'),
      SigAlg: c.req.query('SigAlg'),
    }
  }
  const result = v.safeParse(outboundSloMessageSchema, input)
  if (!result.success) throw new AppError('malformed_request', { httpStatus: 400 })
  const parsed = result.output
  const binding = isPost ? ('post' as const) : ('redirect' as const)
  const relayState = parsed.RelayState?.slice(0, 2048) ?? null
  if (parsed.SAMLRequest !== undefined) {
    return {
      kind: 'request',
      encoded: parsed.SAMLRequest,
      binding,
      relayState,
      ...(binding === 'redirect' && parsed.Signature && parsed.SigAlg
        ? {
            redirectSignature: {
              samlRequestEncoded: parsed.SAMLRequest,
              relayState,
              signature: parsed.Signature,
              sigAlg: parsed.SigAlg,
            },
          }
        : {}),
    }
  }
  if (parsed.SAMLResponse === undefined)
    throw new AppError('malformed_request', { httpStatus: 400 })
  return { kind: 'response', encoded: parsed.SAMLResponse, binding, relayState }
}

async function handleOutboundSlo(c: Context<XidHonoEnv>): Promise<Response> {
  const appId = requiredParam(c, 'appId')
  const sp = await resolveSp(c, appId)
  const cert = await loadSigningCert(c, sp)
  const key = await importSamlSigningKey(cert, c.env.KEK)
  const sloDestination = idpSloUrl(c, appId)
  const message = await readOutboundSloMessage(c)
  const decoded = await decodeSamlBindingPayload(message.encoded, message.binding)
  if (!decoded.ok) throw new AppError('malformed_request', { httpStatus: 400 })

  if (message.kind === 'request') {
    const verified = await verifySamlLogoutRequest(decoded.value, {
      idpCertificatesB64: sp.spCertificates,
      expectedIssuer: sp.spEntityId,
      expectedDestination: sloDestination,
      ...(message.redirectSignature ? { redirectSignature: message.redirectSignature } : {}),
    })
    if (!verified.ok) throw new AppError('signature_invalid', { httpStatus: 401 })

    let bindingHit = null as { userId: string; sessionId: string } | null
    if (verified.value.sessionIndex) {
      bindingHit = await resolveOutboundSamlSessionIndex(c, appId, verified.value.sessionIndex)
    }
    if (bindingHit) await revokeOutboundBinding(c, bindingHit)

    const signed = await signLogoutResponse(
      {
        issuer: idpEntityId(c, appId),
        destination: sp.sloUrl ?? sp.acsUrl,
        inResponseTo: verified.value.requestId,
      },
      key,
    )
    if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })

    if (message.binding === 'redirect' && sp.sloUrl) {
      const param = await encodeRedirectBindingMessage(signed.value.xml)
      const params = new URLSearchParams({ SAMLResponse: param })
      if (message.relayState) params.set('RelayState', message.relayState)
      const sep = sp.sloUrl.includes('?') ? '&' : '?'
      return c.redirect(`${sp.sloUrl}${sep}${params.toString()}`)
    }

    return c.html(
      postBindingForm({
        destination: sp.sloUrl ?? sp.acsUrl,
        samlMessage: signed.value.samlMessage,
        fieldName: 'SAMLResponse',
        relayState: message.relayState,
      }),
      200,
    )
  }

  const verified = await verifySamlLogoutResponse(decoded.value, {
    spCertificatesB64: sp.spCertificates.length > 0 ? sp.spCertificates : undefined,
    expectedIssuer: sp.spEntityId,
    expectedDestination: sloDestination,
  })
  if (!verified.ok) throw new AppError('signature_invalid', { httpStatus: 401 })
  if (verified.value.statusCode !== STATUS_SUCCESS) {
    await auditSloFailure(c, {
      appId,
      kind: 'logout_response',
      statusCode: verified.value.statusCode,
      inResponseTo: verified.value.inResponseTo,
    })
    throw new AppError('invalid_request', { httpStatus: 400 })
  }
  if (verified.value.sessionIndex) {
    const bindingHit = await resolveOutboundSamlSessionIndex(c, appId, verified.value.sessionIndex)
    if (bindingHit) await revokeOutboundBinding(c, bindingHit)
  }
  return c.body(null, 204)
}

async function withOutboundTenant<T>(
  c: Context<XidHonoEnv>,
  appId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tenant = await resolveSamlServiceProviderTenant(c, appId)
  return withTenant(c, tenant, fn)
}

outbound.get('/saml/:appId/metadata', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, async () => {
    const sp = await resolveSp(c, appId)
    const cert = await loadSigningCert(c, sp)
    const xml = buildIdpMetadataXml({
      entityId: idpEntityId(c, appId),
      ssoUrl: idpSsoUrl(c, appId),
      sloUrl: idpSloUrl(c, appId),
      signingCertsB64: [cert.certificate],
      nameIdFormats: [sp.nameIdFormat],
    })
    return c.body(xml, 200, { 'content-type': 'application/samlmetadata+xml' })
  })
})

async function handleSso(c: Context<XidHonoEnv>): Promise<Response> {
  const session = c.get('session')
  if (!session || session.status !== 'active') return loginRedirect(c)

  let formRelayState: string | null = null
  let formSamlRequest: string | null = null
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const relay = form.get('RelayState')
    const request = form.get('SAMLRequest')
    formRelayState = typeof relay === 'string' ? relay : null
    formSamlRequest = typeof request === 'string' ? base64Xml(request) : null
  }

  const appId = requiredParam(c, 'appId')
  const sp = await resolveSp(c, appId)
  const cert = await loadSigningCert(c, sp)
  const key = await importSamlSigningKey(cert, c.env.KEK)
  const user = await readAuthenticatedUser(c, session)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await assertUserPassesAssignmentGate(db, {
    orgId: sp.orgId,
    userId: user.id,
    gate: parseAssignmentGate(sp.attributeMapping as Record<string, unknown>),
  })
  const email = await primaryEmail(c, user)
  const requestXml = formSamlRequest ?? samlRequestFromQuery(c)
  const sessionIndex = session.sessionId
  const signed = await signSamlResponse(
    {
      issuer: idpEntityId(c, appId),
      audience: sp.spEntityId,
      acsUrl: sp.acsUrl,
      subjectNameId: email,
      nameIdFormat: sp.nameIdFormat || DEFAULT_NAME_ID_FORMAT,
      attributes: userAttributes(sp, user, email),
      sessionIndex,
      inResponseTo: authnRequestId(requestXml),
    },
    key,
  )
  if (!signed.ok) {
    throw new AppError('internal_error', {
      httpStatus: 500,
      longMessage: 'outbound_saml_sign_failed',
    })
  }

  const ttlMs = Math.max(0, session.expiresAt.getTime() - Date.now())
  await trackOutboundSamlSession(
    c,
    {
      appId,
      sessionIndex,
      userId: session.userId,
      sessionId: session.sessionId,
      nameId: email,
      nameIdFormat: sp.nameIdFormat || DEFAULT_NAME_ID_FORMAT,
    },
    ttlMs,
  )

  const html = postBindingForm({
    destination: sp.acsUrl,
    samlMessage: signed.value.samlResponse,
    fieldName: 'SAMLResponse',
    relayState: relayStateFromRequest(c, formRelayState),
  })
  return c.html(html, 200)
}

outbound.get('/saml/:appId/sso', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleSso(c))
})
outbound.post('/saml/:appId/sso', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleSso(c))
})

// 出站 IdP:对配置了 sloUrl 的 SP 发 LogoutRequest(登出时 best-effort 触发)。
export async function initiateOutboundSamlLogout(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<void> {
  const tracked = await peekOutboundSamlSessionsForUser(c, session.userId, session.sessionId)
  if (tracked.length === 0) return

  for (const item of tracked) {
    const sp = await resolveSp(c, item.appId)
    if (!sp.sloUrl) continue
    const cert = await loadSigningCert(c, sp)
    const key = await importSamlSigningKey(cert, c.env.KEK)
    const signed = await signLogoutRequest(
      {
        issuer: idpEntityId(c, item.appId),
        destination: sp.sloUrl,
        nameId: item.nameId,
        nameIdFormat: item.nameIdFormat,
        sessionIndex: item.sessionIndex,
      },
      key,
    )
    if (!signed.ok) {
      await auditSloFailure(c, {
        appId: item.appId,
        kind: 'logout_request_sign',
        sessionIndex: item.sessionIndex,
      })
      continue
    }

    const binding = sp.sloBinding === 'post' ? 'post' : 'redirect'
    if (binding === 'post') {
      const res = await fetch(sp.sloUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ SAMLRequest: signed.value.samlMessage }).toString(),
        redirect: 'manual',
      }).catch(async (error) => {
        await auditSloFailure(c, {
          appId: item.appId,
          kind: 'logout_request_fetch',
          sessionIndex: item.sessionIndex,
          error: String(error),
        })
        return null
      })
      if (!res || !res.ok) {
        await auditSloFailure(c, {
          appId: item.appId,
          kind: 'logout_request_fetch',
          sessionIndex: item.sessionIndex,
          status: res?.status ?? null,
        })
      }
      continue
    }

    const redirectParam = await encodeRedirectBindingMessage(signed.value.xml)
    const params = new URLSearchParams({ SAMLRequest: redirectParam })
    const res = await fetch(
      `${sp.sloUrl}${sp.sloUrl.includes('?') ? '&' : '?'}${params.toString()}`,
      {
        method: 'GET',
        redirect: 'manual',
      },
    ).catch(async (error) => {
      await auditSloFailure(c, {
        appId: item.appId,
        kind: 'logout_request_fetch',
        sessionIndex: item.sessionIndex,
        error: String(error),
      })
      return null
    })
    if (!res || !res.ok) {
      await auditSloFailure(c, {
        appId: item.appId,
        kind: 'logout_request_fetch',
        sessionIndex: item.sessionIndex,
        status: res?.status ?? null,
      })
    }
  }
}

outbound.get('/saml/:appId/slo', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleOutboundSlo(c))
})
outbound.post('/saml/:appId/slo', async (c) => {
  const appId = requiredParam(c, 'appId')
  return withOutboundTenant(c, appId, () => handleOutboundSlo(c))
})

export function registerOutboundSamlRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/outbound', outbound)
}
