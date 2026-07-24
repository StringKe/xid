// SAML 2.0 SP 路由:ACS(验签->JIT->session)/ metadata / AuthnRequest 发起(SP-initiated)。
// 见 docs/design/04-enterprise-sso.md 第 1、3、8 节。验签/解密/语义校验全走 @xid-kit/saml(xmldsigjs,不自研)。
// 错误码映射见 saml-errors.ts(8.8);DO 一次性消费见 saml-do.ts;JIT 见 saml-jit.ts;connection 解析见 saml-connection.ts。
// export 注册函数,不直接改 worker/index.ts(wire 阶段统一挂)。

import {
  decodeBase64Xml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  setSamlEngine,
  signLogoutResponse,
  verifySamlLogoutRequest,
  verifySamlResponse,
} from '@xid-kit/saml'
import type { AttributeMapping } from '@xid-kit/saml'
import { createTenantDb, schema } from '@xid-kit/db'
import { DEFAULT_SESSION_POLICY } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError, isAppError } from '../lib/errors'
import { renderProtocolErrorPage } from '../lib/error-page'
import { issueSession, revokeSession } from '../lib/session'
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
import { provisionUser } from './saml-jit'
import {
  consumeAuthnRequestId,
  isAssertionReplay,
  resolveInboundSamlSessionByNameId,
  resolveInboundSamlSessionIndex,
  storeAuthnRequestId,
  storeInboundSamlSessionIndex,
} from './saml-do'
import { buildSpMetadata, redirectToIdp } from './saml-views'
import { resolveSsoConnectionTenant, withTenant } from './tenant'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'

const saml = new Hono<XidHonoEnv>()

// RelayState 最大 2KB(超长截断记日志,见第 1 节决策)。
const RELAY_STATE_MAX = 2048
const DEFAULT_AUTH_RETURN_PATH = '/console'

// base64 XML 上限(字符数):schema 层拒超大 SAMLResponse/SAMLRequest,量级对齐 SAML_METADATA_MAX_BYTES。
const SAML_XML_BASE64_MAX_LENGTH = 256 * 1024

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

// HTTP-Redirect binding 的 SLO query:Signature/SigAlg 成对出现才参与验签(成对性在 domain 层判断)。
const sloRedirectQuerySchema = v.object({
  SAMLRequest: v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
  RelayState: v.optional(v.string()),
  Signature: v.optional(v.string()),
  SigAlg: v.optional(v.string()),
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
    SAMLResponse: form.get('SAMLResponse'),
    RelayState: form.get('RelayState') ?? undefined,
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
): Promise<void> {
  if (!inResponseTo) return
  const ok = await consumeAuthnRequestId(c, connectionId, inResponseTo)
  if (!ok) throw new AppError('recipient_mismatch', { httpStatus: 403 })
}

// ACS 主体(验签 -> 重放/InResponseTo -> JIT -> session -> 回跳 RelayState)。
async function runAcs(c: Context<XidHonoEnv>, connectionId: string): Promise<Response> {
  const connection = await resolveConnection(c, connectionId)
  await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })
  const { samlResponse, relayState } = await readAcsForm(c)

  const assertion = await verifyAcs(c, connection, samlResponse)
  await checkInResponseTo(c, connectionId, assertion.inResponseTo)

  if (await isAssertionReplay(c, connectionId, assertion.assertionId, assertion.notOnOrAfter)) {
    throw new AppError('replay_detected', { httpStatus: 403 })
  }

  const relayTarget = resolveRelayState(c.get('tenant'), relayState)
  const localRelayTarget = relayTarget.startsWith(c.get('tenant').issuer)
    ? relayTarget.slice(c.get('tenant').issuer.length) || DEFAULT_AUTH_RETURN_PATH
    : DEFAULT_AUTH_RETURN_PATH
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
  const sessionId = crypto.randomUUID()
  // SAML sessionIndex 绑定窗口对齐 session absolute 策略(签发生命周期同源,不再各自写字面量)。
  const sessionTtlMs =
    (c.get('tenant').policy.session ?? DEFAULT_SESSION_POLICY).absoluteTimeoutDays *
    24 *
    60 *
    60 *
    1000
  await issueSession(c, {
    sessionId,
    userId,
    activeOrgId: connection.orgId,
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
  const relay = input.relayState
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
  }
}> {
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const parsed = parseShape(sloPostFormSchema, {
      SAMLRequest: form.get('SAMLRequest'),
      RelayState: form.get('RelayState') ?? undefined,
    })
    return {
      encoded: parsed.SAMLRequest,
      binding: 'post',
      relayState: parsed.RelayState?.slice(0, RELAY_STATE_MAX) ?? null,
    }
  }
  const parsed = parseShape(sloRedirectQuerySchema, {
    SAMLRequest: c.req.query('SAMLRequest'),
    RelayState: c.req.query('RelayState'),
    Signature: c.req.query('Signature'),
    SigAlg: c.req.query('SigAlg'),
  })
  const relayState = parsed.RelayState?.slice(0, RELAY_STATE_MAX) ?? null
  return {
    encoded: parsed.SAMLRequest,
    binding: 'redirect',
    relayState,
    ...(parsed.Signature && parsed.SigAlg
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

async function revokeInboundSamlSession(
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
      ...(redirectSignature ? { redirectSignature } : {}),
    })
    if (!verified.ok) throw samlErrorToApp(verified.error.code, verified.error.reason)

    let bindingHit = null as { userId: string; sessionId: string } | null
    if (verified.value.sessionIndex) {
      bindingHit = await resolveInboundSamlSessionIndex(
        c,
        connectionId,
        verified.value.sessionIndex,
      )
    } else if (verified.value.nameId) {
      bindingHit = await resolveInboundSamlSessionByNameId(c, connectionId, verified.value.nameId)
    }
    if (bindingHit) await revokeInboundSamlSession(c, bindingHit)

    const signingKey = await loadSpSigningKey(c)
    if (!signingKey) throw new AppError('connection_not_found', { httpStatus: 404 })

    const responseDestination =
      connection.idpSloUrl ??
      connection.idpSsoUrl?.replace(/\/sso\/?$/, '/slo') ??
      verified.value.issuer
    const signed = await signLogoutResponse(
      {
        issuer: spEntityId(ctx, connectionId),
        destination: responseDestination,
        inResponseTo: verified.value.requestId,
      },
      signingKey,
    )
    if (!signed.ok) {
      throw new AppError('internal_error', {
        httpStatus: 500,
        longMessage: 'saml_slo_sign_failed',
      })
    }

    if (binding === 'redirect') {
      const param = await encodeRedirectBindingMessage(signed.value.xml)
      const params = new URLSearchParams({ SAMLResponse: param })
      if (relayState) params.set('RelayState', relayState)
      const sep = responseDestination.includes('?') ? '&' : '?'
      return c.redirect(`${responseDestination}${sep}${params.toString()}`)
    }

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
  const connectionId = c.req.param('connection')
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })

    const connection = await resolveConnection(c, connectionId)
    return redirectToIdp(c, connection, storeAuthnRequestId)
  })
})

// 注册 SAML SP 路由(wire 阶段统一挂载;前缀 /sso)。
export function registerSamlRoutes(app: Hono<XidHonoEnv>): void {
  setSamlEngine(globalThis.crypto)
  app.route('/sso', saml)
}
