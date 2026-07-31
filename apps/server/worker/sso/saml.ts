// SAML 2.0 SP 路由:ACS(验签->JIT->session)/ metadata / AuthnRequest 发起(SP-initiated)。
// 见 docs/design/04-enterprise-sso.md 第 1、3、8 节。验签/解密/语义校验全走 @xid-kit/saml(xmldsigjs,不自研)。
// 错误码映射见 saml-errors.ts(8.8);DO 一次性消费见 saml-do.ts;JIT 见 saml-jit.ts;connection 解析见 saml-connection.ts。
// export 注册函数,不直接改 worker/index.ts(wire 阶段统一挂)。

import {
  buildLogoutResponseXml,
  decodeBase64Xml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  setSamlEngine,
  signLogoutResponse,
  signRedirectBindingResponse,
  verifySamlLogoutRequest,
  verifySamlResponse,
} from '@xid-kit/saml'
import type { AttributeMapping } from '@xid-kit/saml'
import { createTenantDb, resolveTenantContextByApplicationClientId, schema } from '@xid-kit/db'
import { DEFAULT_SESSION_POLICY } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError, isAppError } from '../lib/errors'
import { renderProtocolErrorPage } from '../lib/error-page'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession, revokeSession, sessionDoRevoke } from '../lib/session'
import type { SessionData } from '../lib/types'
import { SSO_AUTH_CONTEXT } from '../lib/auth-context'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { samlErrorToApp } from './saml-errors'
import {
  acsUrl,
  loadSpDecryptKey,
  loadSpSigningKey,
  resolveConnection,
  sloUrl,
  spEntityId,
} from './saml-connection'
import type { SamlConnection } from './saml-connection'
import { shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
import { readUniqueSamlFormField, readUniqueSamlQueryParameter } from './saml-binding-input'
import { provisionUser } from './saml-jit'
import {
  consumeAuthnRequestContext,
  isAssertionReplay,
  isLogoutRequestReplay,
  releaseLogoutRequestReplay,
  resolveInboundSamlSessionByNameId,
  resolveInboundSamlSessionIndex,
  restoreConsumedSamlSessionBindings,
  storeAuthnRequestId,
  storeInboundSamlSessionIndex,
} from './saml-do'
import type {
  ConsumedSamlSessionBinding,
  SamlAuthnRequestContext,
  SamlLogoutRequestReplayInput,
} from './saml-do'
import { buildSpMetadata, redirectToIdp } from './saml-views'
import { resolveSsoConnectionTenant, withTenant } from './tenant'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'
import {
  isAuthorizeContinuation,
  normalizeLocalContinuePath,
  resolveApplicationAuthorizeContinuation,
} from '../../shared/hosted-auth-continuation'
import { isApplicationSignUpIntent } from '../../shared/hosted-auth-intent'

const saml = new Hono<XidHonoEnv>()

// RelayState 最大 2KB(超长截断记日志,见第 1 节决策)。
const RELAY_STATE_MAX = 2048
const DEFAULT_AUTH_RETURN_PATH = '/console'
const INVITATION_PATH = '/accept-invitation'

// base64 XML 上限(字符数):schema 层拒超大 SAMLResponse/SAMLRequest,量级对齐 SAML_METADATA_MAX_BYTES。
const SAML_XML_BASE64_MAX_LENGTH = 256 * 1024

function isInvitationContinuePath(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value, 'https://xid.invalid')
    return parsed.pathname === INVITATION_PATH || parsed.pathname === `${INVITATION_PATH}/`
  } catch {
    return false
  }
}

function requestHasRawInvitationInput(
  c: Context<XidHonoEnv>,
  continuationParameters: readonly string[],
): boolean {
  const query = new URL(c.req.url).searchParams
  if (query.has('invitation_token') || query.has('invitationToken')) return true
  return continuationParameters.some((name) =>
    query.getAll(name).some((value) => isInvitationContinuePath(value)),
  )
}

// HTTP-POST binding 的 ACS/SLO 表单:SAMLResponse/SAMLRequest 必填,RelayState 可选。
// FormData 值可能是 File,valibot string 直接拒(形状层),不用手写 typeof 守卫。
const acsFormSchema = v.object({
  SAMLResponse: v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
  RelayState: v.optional(v.string()),
})

const sloPostFormSchema = v.object({
  SAMLRequest: v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
  RelayState: v.optional(v.string()),
})

// HTTP-Redirect binding 的 SLO query 必须携带 detached Signature/SigAlg。
const sloRedirectQuerySchema = v.object({
  SAMLRequest: v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
  RelayState: v.optional(v.pipe(v.string(), v.maxLength(RELAY_STATE_MAX))),
  Signature: v.optional(v.pipe(v.string(), v.minLength(1))),
  SigAlg: v.optional(v.pipe(v.string(), v.minLength(1))),
})

// SSO 协议面错误契约是 malformed_request 400(8.8),不走 validation_failed 422,故此处用
// safeParse 自行映射而不调 validateBody。
function parseShape<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input)
  if (!result.success) throw new AppError('malformed_request', { httpStatus: 400 })
  return result.output
}

// connection.attributeMapping(JSON)-> @xid-kit/saml AttributeMapping(仅取 4 个 string 字段)。
// 导出供单测覆盖映射裁剪。
export function toAttributeMapping(raw: Record<string, unknown>): AttributeMapping {
  const pick = (k: string): string | undefined =>
    typeof raw[k] === 'string' ? (raw[k] as string) : undefined
  return {
    ...(pick('email') ? { email: pick('email') } : {}),
    ...(pick('firstName') ? { firstName: pick('firstName') } : {}),
    ...(pick('lastName') ? { lastName: pick('lastName') } : {}),
    ...(pick('groups') ? { groups: pick('groups') } : {}),
  }
}

// RelayState 白名单:必须与本租户 issuer 同 origin,否则回退默认登录后页(防 open redirect,见 8.8 成功分支)。
// 导出供单测覆盖 open redirect 阻断。
export function resolveRelayState(ctx: TenantVar, relayState: string | null): string {
  const fallback = `${ctx.issuer}${DEFAULT_AUTH_RETURN_PATH}`
  if (!relayState) return fallback
  const trimmed = relayState.slice(0, RELAY_STATE_MAX)
  try {
    const issuer = new URL(ctx.issuer)
    const target = new URL(trimmed, issuer.origin)
    if (target.origin !== issuer.origin) return fallback
    return `${target.origin}${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}

// ACS 表单解析:SAMLResponse(base64)+ RelayState(<=2KB)。缺 SAMLResponse -> malformed_request 400。
async function readAcsForm(
  c: Context<XidHonoEnv>,
): Promise<{ samlResponse: string; relayState: string | null }> {
  const form = await c.req.formData()
  const parsed = parseShape(acsFormSchema, {
    SAMLResponse: readUniqueSamlFormField(form, 'SAMLResponse'),
    RelayState: readUniqueSamlFormField(form, 'RelayState'),
  })
  return { samlResponse: parsed.SAMLResponse, relayState: parsed.RelayState ?? null }
}

// 验签 + 解密 + 语义校验(@xid-kit/saml),失败按 8.8 映射 AppError。SP-initiated 由 InResponseTo 推断。
// HTTP-POST binding 的 SAMLResponse 表单字段是标准 base64(spec 8.0),先 base64-decode 得 XML 再进 verify。
async function verifyAcs(c: Context<XidHonoEnv>, connection: SamlConnection, samlResponse: string) {
  const ctx = c.get('tenant')
  const decoded = decodeBase64Xml(samlResponse)
  if (!decoded.ok) throw samlErrorToApp(decoded.error.code, decoded.error.reason)
  const spDecryptKey = await loadSpDecryptKey(c, connection)
  const result = await verifySamlResponse(decoded.value, {
    idpCertificatesB64: connection.idpCertificates,
    expectedIssuer: connection.idpEntityId ?? '',
    expectedAudience: spEntityId(ctx, connection.id),
    acsUrl: acsUrl(ctx, connection.id),
    spInitiated: 'auto',
    wantAuthnResponseSigned: connection.wantAuthnResponseSigned,
    wantAssertionsSigned: connection.wantAssertionsSigned,
    clockSkewToleranceMs: connection.samlClockSkewMs,
    ...(spDecryptKey ? { spDecryptKey } : {}),
    attributeMapping: toAttributeMapping(connection.attributeMapping),
  })
  if (!result.ok) throw samlErrorToApp(result.error.code, result.error.reason)
  return result.value
}

// SP-initiated:InResponseTo 一次性消费校验(未知/已消费 -> recipient_mismatch 403)。
async function checkInResponseTo(
  c: Context<XidHonoEnv>,
  connectionId: string,
  inResponseTo: string | undefined,
): Promise<SamlAuthnRequestContext | null> {
  if (!inResponseTo) return null
  const flow = await consumeAuthnRequestContext(c, connectionId, inResponseTo)
  if (!flow) throw new AppError('recipient_mismatch', { httpStatus: 403 })
  if (isInvitationContinuePath(flow.continuePath)) {
    throw new AppError('invalid_request')
  }
  const tenant = c.get('tenant')
  if (flow.tenantId && flow.tenantId !== tenant.tenantId) {
    throw new AppError('cross_tenant_access_denied')
  }
  if (normalizeLocalContinuePath(flow.continuePath) !== flow.continuePath) {
    throw new AppError('server_error')
  }
  if (flow.applicationClientId) {
    const applicationTenant = await resolveTenantContextByApplicationClientId(
      c.req.raw,
      c.env,
      flow.applicationClientId,
    )
    if (!applicationTenant.ok || applicationTenant.value.tenantId !== tenant.tenantId) {
      throw new AppError('cross_tenant_access_denied')
    }
    if (!resolveApplicationAuthorizeContinuation(flow.continuePath, flow.applicationClientId)) {
      throw new AppError('invalid_request')
    }
  } else if (isAuthorizeContinuation(flow.continuePath)) {
    throw new AppError('invalid_request')
  }
  return flow
}

// ACS 主体(验签 -> 重放/InResponseTo -> JIT -> session -> 回跳 RelayState)。
async function runAcs(c: Context<XidHonoEnv>, connectionId: string): Promise<Response> {
  const connection = await resolveConnection(c, connectionId)
  await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })
  const { samlResponse, relayState } = await readAcsForm(c)
  if (isInvitationContinuePath(relayState)) {
    throw new AppError('invalid_request')
  }

  const assertion = await verifyAcs(c, connection, samlResponse)
  const requestFlow = await checkInResponseTo(c, connectionId, assertion.inResponseTo)

  if (await isAssertionReplay(c, connectionId, assertion.assertionId, assertion.notOnOrAfter)) {
    throw new AppError('replay_detected', { httpStatus: 403 })
  }

  const relayTarget = requestFlow
    ? new URL(requestFlow.continuePath, c.get('tenant').issuer).toString()
    : resolveRelayState(c.get('tenant'), relayState)
  const localRelayTarget = relayTarget.startsWith(c.get('tenant').issuer)
    ? relayTarget.slice(c.get('tenant').issuer.length) || DEFAULT_AUTH_RETURN_PATH
    : DEFAULT_AUTH_RETURN_PATH
  if (!requestFlow && isAuthorizeContinuation(localRelayTarget)) {
    throw new AppError('invalid_request')
  }
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin: localRelayTarget,
  })
  const userId = await provisionUser({
    c,
    connection,
    subject: assertion.subject,
    attributes: assertion.attributes,
    skipDefaultMembership,
  })

  const now = new Date()
  const mfaGate = await resolvePostAuthMfaGate(c, c.get('tenant'), {
    userId,
    returnPath: localRelayTarget,
    sessionAmr: SSO_AUTH_CONTEXT.amr,
  })
  const sessionId = createPersistedId('session')
  // SAML sessionIndex 绑定窗口对齐 session absolute 策略(签发生命周期同源)。
  const sessionTtlMs =
    (c.get('tenant').policy.session ?? DEFAULT_SESSION_POLICY).absoluteTimeoutDays *
    24 *
    60 *
    60 *
    1000
  await issueSession(c, {
    sessionId,
    userId,
    activeOrgId: skipDefaultMembership ? null : connection.orgId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: SSO_AUTH_CONTEXT,
    authenticatedAt: now,
    rememberMe: true,
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  })
  const sessionIndex = assertion.sessionIndex ?? sessionId
  await storeInboundSamlSessionIndex({
    c,
    connectionId,
    sessionIndex,
    nameId: assertion.subject.nameId,
    nameIdFormat: assertion.subject.nameIdFormat,
    binding: { userId, sessionId },
    ttlMs: sessionTtlMs,
  })
  const redirectTarget = mfaGate.redirectUrl
    ? `${c.get('tenant').issuer}${mfaGate.redirectUrl}`
    : relayTarget
  return c.redirect(redirectTarget)
}

// POST /sso/saml/:connection/acs -- ACS 端点。
// ACS 由浏览器经 IdP form POST 触达:协议错误(AppError)渲染 HTML 错误页而不是 JSON,状态码保留。
saml.post('/saml/:connection/acs', async (c) => {
  const connectionId = c.req.param('connection')
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    try {
      return await runAcs(c, connectionId)
    } catch (error) {
      if (isAppError(error)) {
        return renderProtocolErrorPage(c, {
          status: error.httpStatus,
          error: error.code,
          description: error.longMessage ?? error.code,
        })
      }
      throw error
    }
  })
})

// GET /sso/saml/:connection/metadata -- SP metadata XML(application/samlmetadata+xml,见 8.9)。
saml.get('/saml/:connection/metadata', async (c) => {
  const connectionId = c.req.param('connection')
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })
    const connection = await resolveConnection(c, connectionId)
    return buildSpMetadata(c, connection)
  })
})

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sloPostForm(input: {
  destination: string
  samlResponse: string
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
    `<input type="hidden" name="SAMLResponse" value="${htmlEscape(input.samlResponse)}">`,
    relay,
    `</form>`,
    `<script>document.forms[0].submit()</script>`,
    `</body></html>`,
  ].join('')
}

async function readSloRequest(c: Context<XidHonoEnv>): Promise<{
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
}> {
  const readRelayState = (value: string | undefined): string | null => {
    if (value === undefined) return null
    if (value.length > RELAY_STATE_MAX) {
      throw new AppError('malformed_request', { httpStatus: 400 })
    }
    return value
  }
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const parsed = parseShape(sloPostFormSchema, {
      SAMLRequest: readUniqueSamlFormField(form, 'SAMLRequest'),
      RelayState: readUniqueSamlFormField(form, 'RelayState'),
    })
    return {
      encoded: parsed.SAMLRequest,
      binding: 'post',
      relayState: readRelayState(parsed.RelayState),
    }
  }
  const requestParameter = readUniqueSamlQueryParameter(c.req.url, 'SAMLRequest')
  const relayStateParameter = readUniqueSamlQueryParameter(c.req.url, 'RelayState')
  const signatureParameter = readUniqueSamlQueryParameter(c.req.url, 'Signature')
  const sigAlgParameter = readUniqueSamlQueryParameter(c.req.url, 'SigAlg')
  const parsed = parseShape(sloRedirectQuerySchema, {
    SAMLRequest: requestParameter?.value,
    RelayState: relayStateParameter?.value,
    Signature: signatureParameter?.value,
    SigAlg: sigAlgParameter?.value,
  })
  const relayState = readRelayState(parsed.RelayState)
  if (!parsed.Signature || !parsed.SigAlg) {
    throw new AppError('malformed_request', { httpStatus: 400 })
  }
  return {
    encoded: parsed.SAMLRequest,
    binding: 'redirect',
    relayState,
    redirectSignature: {
      samlRequestEncoded: parsed.SAMLRequest,
      relayState,
      signature: parsed.Signature,
      sigAlg: parsed.SigAlg,
      wireEncoded: {
        samlMessage: requestParameter!.wireValue,
        relayState: relayStateParameter?.wireValue ?? null,
        sigAlg: sigAlgParameter!.wireValue,
      },
    },
  }
}

async function revokeInboundSamlSession(
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

async function attemptAllInboundSessionRevocations(
  c: Context<XidHonoEnv>,
  bindings: readonly ConsumedSamlSessionBinding[],
): Promise<{ cause: unknown } | null> {
  let firstFailure: { cause: unknown } | null = null
  for (const binding of bindings) {
    try {
      await revokeInboundSamlSession(c, binding)
    } catch (cause) {
      firstFailure ??= { cause }
    }
  }
  return firstFailure
}

async function consumeVerifiedInboundLogoutRequest(
  c: Context<XidHonoEnv>,
  connectionId: string,
  verified: {
    requestId: string
    validUntil: number
    sessionIndexes: readonly string[]
    nameId?: string
  },
): Promise<void> {
  const replayInput: SamlLogoutRequestReplayInput = {
    direction: 'inbound',
    scopeId: connectionId,
    requestId: verified.requestId,
    validUntil: verified.validUntil,
  }
  if (await isLogoutRequestReplay(c, replayInput)) {
    throw samlErrorToApp('replay_detected', 'LogoutRequest was already consumed')
  }
  const bindings: ConsumedSamlSessionBinding[] = []
  let consumeFailure: { cause: unknown } | null = null
  if (verified.sessionIndexes.length > 0) {
    for (const sessionIndex of new Set(verified.sessionIndexes)) {
      try {
        const binding = await resolveInboundSamlSessionIndex(c, connectionId, sessionIndex)
        if (binding) bindings.push(binding)
      } catch (cause) {
        consumeFailure ??= { cause }
      }
    }
  } else if (verified.nameId) {
    try {
      bindings.push(...(await resolveInboundSamlSessionByNameId(c, connectionId, verified.nameId)))
    } catch (cause) {
      consumeFailure = { cause }
    }
  }
  const revokeFailure = await attemptAllInboundSessionRevocations(c, bindings)
  const failure = consumeFailure ?? revokeFailure
  if (failure) {
    await restoreConsumedSamlSessionBindings(c, {
      direction: 'inbound',
      scopeId: connectionId,
      bindings,
    })
    await releaseLogoutRequestReplay(c, replayInput)
    throw new AppError('server_error', { cause: failure.cause })
  }
}

async function handleInboundSlo(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connection')
  if (!connectionId) throw new AppError('not_found', { httpStatus: 404 })
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveConnection(c, connectionId)
    await enforceEnterpriseSsoPolicy({ c, action: 'logout', email: null })
    const ctx = c.get('tenant')
    const { encoded, binding, relayState, redirectSignature } = await readSloRequest(c)
    const decoded = await decodeSamlBindingPayload(encoded, binding)
    if (!decoded.ok) throw samlErrorToApp(decoded.error.code, decoded.error.reason)

    const verified = await verifySamlLogoutRequest(decoded.value, {
      idpCertificatesB64: connection.idpCertificates,
      expectedIssuer: connection.idpEntityId ?? '',
      expectedDestination: sloUrl(ctx, connectionId),
      clockSkewToleranceMs: connection.samlClockSkewMs,
      ...(redirectSignature ? { redirectSignature } : {}),
    })
    if (!verified.ok) throw samlErrorToApp(verified.error.code, verified.error.reason)

    const responseDestination = connection.idpSloUrl
    if (!responseDestination) {
      throw new AppError('connection_not_found', { httpStatus: 404 })
    }
    const signingKey = await loadSpSigningKey(c)
    if (!signingKey) throw new AppError('connection_not_found', { httpStatus: 404 })
    const responseInput = {
      issuer: spEntityId(ctx, connectionId),
      destination: responseDestination,
      inResponseTo: verified.value.requestId,
    }

    if (binding === 'redirect') {
      const built = buildLogoutResponseXml(responseInput)
      const param = await encodeRedirectBindingMessage(built.xml)
      const signed = await signRedirectBindingResponse(param, relayState, signingKey)
      if (!signed.ok) {
        throw new AppError('internal_error', {
          httpStatus: 500,
          longMessage: 'saml_slo_sign_failed',
        })
      }
      await consumeVerifiedInboundLogoutRequest(c, connectionId, verified.value)
      const sep = responseDestination.includes('?') ? '&' : '?'
      return c.redirect(`${responseDestination}${sep}${signed.value.query}`)
    }

    const signed = await signLogoutResponse(responseInput, signingKey)
    if (!signed.ok) {
      throw new AppError('internal_error', {
        httpStatus: 500,
        longMessage: 'saml_slo_sign_failed',
      })
    }
    await consumeVerifiedInboundLogoutRequest(c, connectionId, verified.value)

    const html = sloPostForm({
      destination: responseDestination,
      samlResponse: signed.value.samlMessage,
      relayState,
    })
    return c.html(html, 200)
  })
}

// GET/POST /sso/saml/:connection/slo -- 入站 SAML SLO(LogoutRequest -> 撤销 session -> LogoutResponse)。
saml.get('/saml/:connection/slo', handleInboundSlo)
saml.post('/saml/:connection/slo', handleInboundSlo)

// GET /sso/saml/:connection/login -- SP-initiated AuthnRequest 发起(302 到 IdP SSO URL)。
saml.get('/saml/:connection/login', async (c) => {
  if (requestHasRawInvitationInput(c, ['relay_state', 'RelayState', 'redirect_uri', 'continue'])) {
    throw new AppError('invalid_request')
  }
  const connectionId = c.req.param('connection')
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })

    const connection = await resolveConnection(c, connectionId)
    const rawContinue =
      c.req.query('relay_state') ?? c.req.query('continue') ?? DEFAULT_AUTH_RETURN_PATH
    const applicationClientId = c.req.query('client_id')?.trim() || null
    const applicationContinuation = applicationClientId
      ? resolveApplicationAuthorizeContinuation(rawContinue, applicationClientId)
      : null
    const continuePath = applicationContinuation ?? normalizeLocalContinuePath(rawContinue)
    if (
      !continuePath ||
      (applicationClientId && !applicationContinuation) ||
      (!applicationClientId && isAuthorizeContinuation(continuePath)) ||
      (isApplicationSignUpIntent(c.req.query('intent')) && !applicationClientId)
    ) {
      throw new AppError('invalid_request')
    }
    if (applicationClientId) {
      const applicationTenant = await resolveTenantContextByApplicationClientId(
        c.req.raw,
        c.env,
        applicationClientId,
      )
      if (!applicationTenant.ok || applicationTenant.value.tenantId !== tenant.tenantId) {
        throw new AppError('cross_tenant_access_denied')
      }
    }
    return redirectToIdp(c, connection, storeAuthnRequestId, {
      tenantId: tenant.tenantId,
      continuePath,
      applicationClientId,
    })
  })
})

// 注册 SAML SP 路由(wire 阶段统一挂载;前缀 /sso)。
export function registerSamlRoutes(app: Hono<XidHonoEnv>): void {
  setSamlEngine(globalThis.crypto)
  app.route('/sso', saml)
}
