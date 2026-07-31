// Outbound SAML IdP:XID 给下游 SaaS SP 发 signed SAML Response。
// 与 inbound `/sso/saml/:connection/*` 分离,避免把 XID 作为 SP 和 IdP 的角色混用。

import { envelopeDecrypt, toBufferSource } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import {
  buildIdpMetadataXml,
  buildLogoutRequestXml,
  buildLogoutResponseXml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  signLogoutRequest,
  signLogoutResponse,
  signRedirectBindingRequest,
  signRedirectBindingResponse,
  signSamlResponse,
  loadIdpVerifyKey,
  verifySamlAuthnRequest,
  verifySamlLogoutRequest,
  verifySamlLogoutResponse,
} from '@xid-kit/saml'
import type { SamlAttributeValue } from '@xid-kit/saml'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { revokeSession, sessionDoRevoke } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'
import {
  consumeOutboundLogoutRequestContext,
  isLogoutRequestReplay,
  peekOutboundSamlSessionsForUser,
  releaseLogoutRequestReplay,
  resolveOutboundSamlSessionIndex,
  storeOutboundLogoutRequestContext,
  trackOutboundSamlSession,
} from './saml-do'
import type { OutboundSamlLogoutTarget, SamlLogoutRequestReplayInput } from './saml-do'
import { decodeKek } from '../oidc/shared'
import { resolveSamlServiceProviderTenant, withTenant } from './tenant'
import {
  assertUserPassesAssignmentGate,
  parseAssignmentGate,
  withoutAssignmentGate,
} from './assignment-gate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { readUniqueSamlFormField, readUniqueSamlQueryParameter } from './saml-binding-input'
import type { SamlQueryParameter } from './saml-binding-input'
import {
  resolveOutboundSamlSessionByNameId,
  restoreConsumedSamlSessionBindings,
} from './saml-session-bindings'
import type { ConsumedSamlSessionBinding } from './saml-session-bindings'

type SamlServiceProvider = typeof schema.samlServiceProviders.$inferSelect
type CertRow = typeof schema.certStore.$inferSelect
type UserRow = typeof schema.users.$inferSelect

const outbound = new Hono<XidHonoEnv>()
const DEFAULT_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED = false
const RELAY_STATE_MAX_LENGTH = 2048
const SAML_XML_BASE64_MAX_LENGTH = 256 * 1024

function requiredParam(c: Context<XidHonoEnv>, name: string): string {
  const value = c.req.param(name)
  if (!value) throw new AppError('invalid_request', { httpStatus: 400 })
  return value
}

function readRelayState(value: string | undefined): string | null {
  if (value === undefined) return null
  if (value.length > RELAY_STATE_MAX_LENGTH) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
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
  const permitsLoopbackHttp = isDevOrTestEnvironment(c.env)
  const endpointAllowed = (value: string): boolean =>
    isPublicHttpsUrl(value) || (permitsLoopbackHttp && isLoopbackHttpUrl(value))
  if (
    !row ||
    !endpointAllowed(row.acsUrl) ||
    (row.sloUrl !== null && row.sloUrl !== undefined && !endpointAllowed(row.sloUrl))
  ) {
    throw new AppError('connection_not_found', { httpStatus: 404 })
  }
  return row
}

async function loadSigningCert(c: Context<XidHonoEnv>, sp: SamlServiceProvider): Promise<CertRow> {
  if (!sp.idpSigningCertId) throw new AppError('connection_not_found', { httpStatus: 404 })
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const cert = await db.certStore.findOne(
    and(
      eq(schema.certStore.id, sp.idpSigningCertId),
      eq(schema.certStore.usage, 'saml_idp_signing'),
      inArray(schema.certStore.status, ['active', 'retiring']),
    ),
  )
  if (!cert) throw new AppError('connection_not_found', { httpStatus: 404 })
  const parsed = await loadIdpVerifyKey(cert.certificate)
  const now = Date.now()
  if (!parsed.ok || parsed.value.notBefore > now || parsed.value.notAfter <= now) {
    throw new AppError('connection_not_found', { httpStatus: 404 })
  }
  return cert
}

async function importSamlSigningKey(cert: CertRow, kekB64: string): Promise<CryptoKey> {
  const kek = decodeKek(kekB64)
  let pkcs8: Uint8Array | null = null
  try {
    pkcs8 = await envelopeDecrypt(
      {
        iv: new Uint8Array(cert.privateKeyIv),
        ciphertext: new Uint8Array(cert.privateKeyCiphertext),
        tag: new Uint8Array(cert.privateKeyTag),
        kekVersion: cert.kekVersion,
        kid: cert.id,
        alg: 'RS256',
      },
      kek,
    )
    return await crypto.subtle.importKey(
      'pkcs8',
      toBufferSource(pkcs8),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  } finally {
    pkcs8?.fill(0)
    kek.fill(0)
  }
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

function loginRedirect(c: Context<XidHonoEnv>): Response {
  const url = new URL(`${c.get('tenant').issuer}/sign-in`)
  const requestUrl = new URL(c.req.url)
  url.searchParams.set('continue', `${requestUrl.pathname}${requestUrl.search}`)
  return c.redirect(url.toString(), 302)
}

function postBindingForm(input: {
  destination: string
  samlMessage: string
  fieldName: 'SAMLRequest' | 'SAMLResponse'
  relayState: string | null
}): string {
  const relay =
    input.relayState !== null
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

export type OutboundSamlLogoutAction =
  | {
      binding: 'redirect'
      url: string
    }
  | {
      binding: 'post'
      destination: string
      samlRequest: string
      relayState: string
    }

function logoutReturnTo(c: Context<XidHonoEnv>): string {
  return `${c.get('tenant').issuer}/sign-in`
}

function safeLogoutReturnTo(c: Context<XidHonoEnv>, value: string): string {
  const fallback = logoutReturnTo(c)
  try {
    const issuer = new URL(c.get('tenant').issuer)
    const target = new URL(value)
    return target.origin === issuer.origin ? target.toString() : fallback
  } catch {
    return fallback
  }
}

async function prepareOutboundSamlLogoutAction(
  c: Context<XidHonoEnv>,
  target: OutboundSamlLogoutTarget,
  remaining: readonly OutboundSamlLogoutTarget[],
  returnTo: string,
): Promise<OutboundSamlLogoutAction> {
  const sp = await resolveSp(c, target.appId)
  if (!sp.sloUrl) throw new AppError('connection_not_found', { httpStatus: 404 })
  const cert = await loadSigningCert(c, sp)
  const key = await importSamlSigningKey(cert, c.env.KEK)
  const requestInput = {
    issuer: idpEntityId(c, target.appId),
    destination: sp.sloUrl,
    nameId: target.nameId,
    nameIdFormat: target.nameIdFormat,
    sessionIndex: target.sessionIndex,
  }
  const relayState = returnTo

  if (sp.sloBinding === 'post') {
    const signed = await signLogoutRequest(requestInput, key)
    if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
    await storeOutboundLogoutRequestContext(c, {
      appId: target.appId,
      requestId: signed.value.messageId,
      sessionIndex: target.sessionIndex,
      relayState,
      returnTo,
      remaining,
    })
    return {
      binding: 'post',
      destination: sp.sloUrl,
      samlRequest: signed.value.samlMessage,
      relayState,
    }
  }

  const built = buildLogoutRequestXml(requestInput)
  const encoded = await encodeRedirectBindingMessage(built.xml)
  const signed = await signRedirectBindingRequest(encoded, relayState, key)
  if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
  await storeOutboundLogoutRequestContext(c, {
    appId: target.appId,
    requestId: built.requestId,
    sessionIndex: target.sessionIndex,
    relayState,
    returnTo,
    remaining,
  })
  return {
    binding: 'redirect',
    url: `${sp.sloUrl}${sp.sloUrl.includes('?') ? '&' : '?'}${signed.value.query}`,
  }
}

async function prepareFirstAvailableLogoutAction(
  c: Context<XidHonoEnv>,
  targets: readonly OutboundSamlLogoutTarget[],
  returnTo: string,
): Promise<OutboundSamlLogoutAction | null> {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!
    try {
      return await prepareOutboundSamlLogoutAction(c, target, targets.slice(index + 1), returnTo)
    } catch (error) {
      await auditSloFailure(c, {
        appId: target.appId,
        kind: 'logout_request_prepare',
        sessionIndex: target.sessionIndex,
        error: String(error),
      })
    }
  }
  return null
}

function renderOutboundLogoutAction(
  c: Context<XidHonoEnv>,
  action: OutboundSamlLogoutAction,
): Response {
  if (action.binding === 'redirect') return c.redirect(action.url)
  return c.html(
    postBindingForm({
      destination: action.destination,
      samlMessage: action.samlRequest,
      fieldName: 'SAMLRequest',
      relayState: action.relayState,
    }),
    200,
  )
}

async function revokeOutboundBinding(
  c: Context<XidHonoEnv>,
  binding: { userId: string; sessionId: string },
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.sessions.findOne(eq(schema.sessions.id, binding.sessionId))
  if (!row || row.status !== 'active') return
  if (row.userId !== binding.userId) {
    throw new AppError('server_error', {
      cause: new Error('SAML session binding user mismatch'),
    })
  }
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
  try {
    await revokeSession(c, session)
  } catch (cause) {
    const fallback = await Promise.allSettled([
      sessionDoRevoke(c.env, binding.userId, binding.sessionId),
      db.sessions.update(
        { status: 'revoked' },
        and(
          eq(schema.sessions.id, binding.sessionId),
          eq(schema.sessions.userId, binding.userId),
          eq(schema.sessions.status, 'active'),
        ),
      ),
    ])
    if (fallback.some((result) => result.status === 'fulfilled')) return
    throw new AppError('server_error', {
      cause: new AggregateError(
        [
          cause,
          ...fallback.map((result) =>
            result.status === 'rejected' ? result.reason : new Error('unexpected success'),
          ),
        ],
        'SAML session revocation failed in both stores',
      ),
    })
  }
}

async function attemptAllOutboundSessionRevocations(
  c: Context<XidHonoEnv>,
  bindings: readonly ConsumedSamlSessionBinding[],
): Promise<{ cause: unknown } | null> {
  let firstFailure: { cause: unknown } | null = null
  for (const binding of bindings) {
    try {
      await revokeOutboundBinding(c, binding)
    } catch (cause) {
      firstFailure ??= { cause }
    }
  }
  return firstFailure
}

async function consumeVerifiedOutboundLogoutRequest(
  c: Context<XidHonoEnv>,
  input: {
    appId: string
    requestId: string
    validUntil: number
    sessionIndexes: readonly string[]
    nameId?: string
  },
): Promise<void> {
  const replayInput: SamlLogoutRequestReplayInput = {
    direction: 'outbound',
    scopeId: input.appId,
    requestId: input.requestId,
    validUntil: input.validUntil,
  }
  if (await isLogoutRequestReplay(c, replayInput)) {
    throw new AppError('replay_detected', { httpStatus: 403 })
  }
  const bindings: ConsumedSamlSessionBinding[] = []
  let consumeFailure: { cause: unknown } | null = null
  if (input.sessionIndexes.length > 0) {
    for (const sessionIndex of new Set(input.sessionIndexes)) {
      try {
        const binding = await resolveOutboundSamlSessionIndex(c, input.appId, sessionIndex)
        if (binding) bindings.push(binding)
      } catch (cause) {
        consumeFailure ??= { cause }
      }
    }
  } else if (input.nameId) {
    try {
      bindings.push(...(await resolveOutboundSamlSessionByNameId(c, input.appId, input.nameId)))
    } catch (cause) {
      consumeFailure = { cause }
    }
  }
  const revokeFailure = await attemptAllOutboundSessionRevocations(c, bindings)
  const failure = consumeFailure ?? revokeFailure
  if (failure) {
    await restoreConsumedSamlSessionBindings(c, {
      direction: 'outbound',
      scopeId: input.appId,
      bindings,
    })
    await releaseLogoutRequestReplay(c, replayInput)
    throw new AppError('server_error', { cause: failure.cause })
  }
}

// SLO 消息:SAMLRequest 与 SAMLResponse 严格二选一。HTTP-Redirect 必须携带 detached
// Signature/SigAlg，HTTP-POST 的签名位于 XML 内。
// 形状失败按 malformed_request 400(协议错误格式),不走 validation_failed,故用 safeParse 自映射。
const outboundSloMessageSchema = v.pipe(
  v.object({
    SAMLRequest: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
    ),
    SAMLResponse: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
    ),
    RelayState: v.optional(v.pipe(v.string(), v.maxLength(RELAY_STATE_MAX_LENGTH))),
    Signature: v.optional(v.pipe(v.string(), v.minLength(1))),
    SigAlg: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.check(
    (input) => (input.SAMLRequest === undefined) !== (input.SAMLResponse === undefined),
    'exactly one of SAMLRequest or SAMLResponse is required',
  ),
)

type OutboundSloMessage =
  | {
      kind: 'request'
      encoded: string
      binding: 'post' | 'redirect'
      relayState: string | null
      redirectSignature?: {
        samlRequestEncoded: string
        relayState?: string | null
        signature: string
        sigAlg: string
        wireEncoded: {
          samlMessage: string
          relayState: string | null
          sigAlg: string
        }
      }
    }
  | {
      kind: 'response'
      encoded: string
      binding: 'post' | 'redirect'
      relayState: string | null
      redirectSignature?: {
        samlResponseEncoded: string
        relayState?: string | null
        signature: string
        sigAlg: string
        wireEncoded: {
          samlMessage: string
          relayState: string | null
          sigAlg: string
        }
      }
    }

async function readOutboundSloMessage(c: Context<XidHonoEnv>): Promise<OutboundSloMessage> {
  const isPost = c.req.method === 'POST'
  // FormData 值可能是 File,交给 schema 拒绝,故输入按 unknown 收集。
  let input: Record<string, unknown>
  let requestParameter: SamlQueryParameter | undefined
  let responseParameter: SamlQueryParameter | undefined
  let relayStateParameter: SamlQueryParameter | undefined
  let signatureParameter: SamlQueryParameter | undefined
  let sigAlgParameter: SamlQueryParameter | undefined
  if (isPost) {
    const form = await c.req.formData()
    input = {
      SAMLRequest: readUniqueSamlFormField(form, 'SAMLRequest'),
      SAMLResponse: readUniqueSamlFormField(form, 'SAMLResponse'),
      RelayState: readUniqueSamlFormField(form, 'RelayState'),
    }
  } else {
    requestParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLRequest')
    responseParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLResponse')
    relayStateParameter = readUniqueSamlQueryParameter(c.req.url, 'RelayState')
    signatureParameter = readUniqueSamlQueryParameter(c.req.url, 'Signature')
    sigAlgParameter = readUniqueSamlQueryParameter(c.req.url, 'SigAlg')
    input = {
      SAMLRequest: requestParameter?.value,
      SAMLResponse: responseParameter?.value,
      RelayState: relayStateParameter?.value,
      Signature: signatureParameter?.value,
      SigAlg: sigAlgParameter?.value,
    }
  }
  const result = v.safeParse(outboundSloMessageSchema, input)
  if (!result.success) throw new AppError('malformed_request', { httpStatus: 400 })
  const parsed = result.output
  const binding = isPost ? ('post' as const) : ('redirect' as const)
  const relayState = readRelayState(parsed.RelayState)
  if (binding === 'redirect' && (!parsed.Signature || !parsed.SigAlg)) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  if (parsed.SAMLRequest !== undefined) {
    return {
      kind: 'request',
      encoded: parsed.SAMLRequest,
      binding,
      relayState,
      ...(binding === 'redirect'
        ? {
            redirectSignature: {
              samlRequestEncoded: parsed.SAMLRequest,
              relayState,
              signature: parsed.Signature!,
              sigAlg: parsed.SigAlg!,
              wireEncoded: {
                samlMessage: requestParameter!.wireValue,
                relayState: relayStateParameter?.wireValue ?? null,
                sigAlg: sigAlgParameter!.wireValue,
              },
            },
          }
        : {}),
    }
  }
  if (parsed.SAMLResponse === undefined) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  return {
    kind: 'response',
    encoded: parsed.SAMLResponse,
    binding,
    relayState,
    ...(binding === 'redirect'
      ? {
          redirectSignature: {
            samlResponseEncoded: parsed.SAMLResponse,
            relayState,
            signature: parsed.Signature!,
            sigAlg: parsed.SigAlg!,
            wireEncoded: {
              samlMessage: responseParameter!.wireValue,
              relayState: relayStateParameter?.wireValue ?? null,
              sigAlg: sigAlgParameter!.wireValue,
            },
          },
        }
      : {}),
  }
}

type OutboundSsoMessage = {
  requestXml: string | null
  relayState: string | null
  redirectSignature?: {
    samlRequestEncoded: string
    relayState?: string | null
    signature: string
    sigAlg: string
    wireEncoded: {
      samlMessage: string
      relayState: string | null
      sigAlg: string
    }
  }
}

async function readOutboundSsoMessage(c: Context<XidHonoEnv>): Promise<OutboundSsoMessage> {
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const request = readUniqueSamlFormField(form, 'SAMLRequest')
    const relay = readUniqueSamlFormField(form, 'RelayState')
    if (request !== undefined && typeof request !== 'string') {
      throw new AppError('malformed_request', { httpStatus: 400 })
    }
    const relayState = readRelayState(typeof relay === 'string' ? relay : undefined)
    if (request === undefined) return { requestXml: null, relayState }
    if (request.length === 0) throw new AppError('malformed_request', { httpStatus: 400 })
    const decoded = await decodeSamlBindingPayload(request, 'post')
    if (!decoded.ok) throw new AppError('malformed_request', { httpStatus: 400 })
    return { requestXml: decoded.value, relayState }
  }

  const requestParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLRequest')
  const standardRelayParameter = readUniqueSamlQueryParameter(c.req.url, 'RelayState')
  const legacyRelayParameter = readUniqueSamlQueryParameter(c.req.url, 'relay_state')
  if (standardRelayParameter !== undefined && legacyRelayParameter !== undefined) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  const relayParameter = standardRelayParameter ?? legacyRelayParameter
  const signatureParameter = readUniqueSamlQueryParameter(c.req.url, 'Signature')
  const sigAlgParameter = readUniqueSamlQueryParameter(c.req.url, 'SigAlg')
  const request = requestParameter?.value
  const relay = relayParameter?.value
  const signature = signatureParameter?.value
  const sigAlg = sigAlgParameter?.value
  const relayState = readRelayState(relay)
  if (request === undefined) {
    if (signature !== undefined || sigAlg !== undefined) {
      throw new AppError('malformed_request', { httpStatus: 400 })
    }
    return { requestXml: null, relayState }
  }
  if (request.length === 0) throw new AppError('malformed_request', { httpStatus: 400 })
  if (request.length > SAML_XML_BASE64_MAX_LENGTH) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  if ((signature === undefined) !== (sigAlg === undefined) || signature === '' || sigAlg === '') {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  const decoded = await decodeSamlBindingPayload(request, 'redirect')
  if (!decoded.ok) throw new AppError('malformed_request', { httpStatus: 400 })
  return {
    requestXml: decoded.value,
    relayState,
    ...(signature && sigAlg
      ? {
          redirectSignature: {
            samlRequestEncoded: request,
            relayState,
            signature,
            sigAlg,
            wireEncoded: {
              samlMessage: requestParameter!.wireValue,
              relayState: relayParameter?.wireValue ?? null,
              sigAlg: sigAlgParameter!.wireValue,
            },
          },
        }
      : {}),
  }
}

function throwOutboundAuthnRequestError(code: string): never {
  if (code === 'signature_required' || code === 'signature_invalid' || code === 'weak_algorithm') {
    throw new AppError('signature_invalid', { httpStatus: 401 })
  }
  throw new AppError('malformed_request', { httpStatus: 400 })
}

async function handleOutboundSlo(c: Context<XidHonoEnv>): Promise<Response> {
  const appId = requiredParam(c, 'appId')
  const sp = await resolveSp(c, appId)
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
    if (!sp.sloUrl) throw new AppError('connection_not_found', { httpStatus: 404 })
    const cert = await loadSigningCert(c, sp)
    const key = await importSamlSigningKey(cert, c.env.KEK)
    const responseInput = {
      issuer: idpEntityId(c, appId),
      destination: sp.sloUrl,
      inResponseTo: verified.value.requestId,
    }
    if (message.binding === 'redirect') {
      const built = buildLogoutResponseXml(responseInput)
      const param = await encodeRedirectBindingMessage(built.xml)
      const signed = await signRedirectBindingResponse(param, message.relayState, key)
      if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
      await consumeVerifiedOutboundLogoutRequest(c, {
        appId,
        requestId: verified.value.requestId,
        validUntil: verified.value.validUntil,
        sessionIndexes: verified.value.sessionIndexes,
        ...(verified.value.nameId ? { nameId: verified.value.nameId } : {}),
      })
      const sep = sp.sloUrl.includes('?') ? '&' : '?'
      return c.redirect(`${sp.sloUrl}${sep}${signed.value.query}`)
    }

    const signed = await signLogoutResponse(responseInput, key)
    if (!signed.ok) throw new AppError('internal_error', { httpStatus: 500 })
    await consumeVerifiedOutboundLogoutRequest(c, {
      appId,
      requestId: verified.value.requestId,
      validUntil: verified.value.validUntil,
      sessionIndexes: verified.value.sessionIndexes,
      ...(verified.value.nameId ? { nameId: verified.value.nameId } : {}),
    })
    return c.html(
      postBindingForm({
        destination: sp.sloUrl,
        samlMessage: signed.value.samlMessage,
        fieldName: 'SAMLResponse',
        relayState: message.relayState,
      }),
      200,
    )
  }

  const verified = await verifySamlLogoutResponse(decoded.value, {
    spCertificatesB64: sp.spCertificates,
    expectedIssuer: sp.spEntityId,
    expectedDestination: sloDestination,
    requireSignature: true,
    ...(message.redirectSignature ? { redirectSignature: message.redirectSignature } : {}),
  })
  if (!verified.ok) throw new AppError('signature_invalid', { httpStatus: 401 })
  if (message.relayState === null) throw new AppError('invalid_request', { httpStatus: 400 })
  const requestContext = await consumeOutboundLogoutRequestContext(
    c,
    appId,
    verified.value.inResponseTo,
    message.relayState,
  )
  if (!requestContext) throw new AppError('invalid_request', { httpStatus: 400 })
  if (message.relayState !== requestContext.relayState) {
    throw new AppError('invalid_request', { httpStatus: 400 })
  }
  const succeeded = verified.value.statusCode === STATUS_SUCCESS
  if (!succeeded) {
    await auditSloFailure(c, {
      appId,
      kind: 'logout_response',
      statusCode: verified.value.statusCode,
      inResponseTo: verified.value.inResponseTo,
    })
  }
  if (succeeded) {
    const bindingHit = await resolveOutboundSamlSessionIndex(c, appId, requestContext.sessionIndex)
    if (bindingHit) await revokeOutboundBinding(c, bindingHit)
  }
  const next = await prepareFirstAvailableLogoutAction(
    c,
    requestContext.remaining,
    safeLogoutReturnTo(c, requestContext.returnTo),
  )
  if (next) return renderOutboundLogoutAction(c, next)
  return c.redirect(safeLogoutReturnTo(c, requestContext.returnTo))
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
      wantAuthnRequestsSigned: OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED,
    })
    return c.body(xml, 200, { 'content-type': 'application/samlmetadata+xml' })
  })
})

async function handleSso(c: Context<XidHonoEnv>): Promise<Response> {
  const session = c.get('session')
  if (!session || session.status !== 'active') return loginRedirect(c)

  const appId = requiredParam(c, 'appId')
  const sp = await resolveSp(c, appId)
  const message = await readOutboundSsoMessage(c)
  let inResponseTo: string | undefined
  if (message.requestXml) {
    const verified = await verifySamlAuthnRequest(message.requestXml, {
      expectedIssuer: sp.spEntityId,
      expectedDestination: idpSsoUrl(c, appId),
      expectedAcsUrl: sp.acsUrl,
      spCertificatesB64: sp.spCertificates,
      requireSignature: OUTBOUND_AUTHN_REQUEST_SIGNATURE_REQUIRED,
      ...(message.redirectSignature ? { redirectSignature: message.redirectSignature } : {}),
    })
    if (!verified.ok) throwOutboundAuthnRequestError(verified.error.code)
    inResponseTo = verified.value.requestId
  }
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
      inResponseTo,
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
    relayState: message.relayState,
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

// 出站 IdP:准备浏览器执行的首个 SLO action；后续 SP 由 /slo LogoutResponse 回调串联。
export async function initiateOutboundSamlLogout(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<OutboundSamlLogoutAction | null> {
  let tracked: Awaited<ReturnType<typeof peekOutboundSamlSessionsForUser>>
  try {
    tracked = await peekOutboundSamlSessionsForUser(c, session.userId, session.sessionId)
  } catch (error) {
    await auditSloFailure(c, {
      appId: null,
      kind: 'logout_request_discovery',
      sessionId: session.sessionId,
      error: String(error),
    })
    return null
  }
  const targets: OutboundSamlLogoutTarget[] = tracked
    .filter((item) => item.nameId !== '' && item.nameIdFormat !== '')
    .map((item) => ({
      appId: item.appId,
      sessionIndex: item.sessionIndex,
      nameId: item.nameId,
      nameIdFormat: item.nameIdFormat,
    }))
  return prepareFirstAvailableLogoutAction(c, targets, logoutReturnTo(c))
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
