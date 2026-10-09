// SAML 2.0 SP 路由:ACS(验签->JIT->session)/ metadata / AuthnRequest 发起(SP-initiated)/ SLO。
// 见 docs/design/04-enterprise-sso.md 第 1、3、8 节。验签/解密/语义校验全走 @xid-kit/saml(xmldsigjs,不自研)。
// 错误码映射见 saml-errors.ts(8.8);DO 一次性消费见 saml-do.ts;JIT 见 jit.ts;connection 解析见 saml-connection.ts;
// 入站 SLO 见 saml-slo.ts;断言映射与 RelayState 白名单见 saml-acs-mapping.ts。
// export 注册函数,不直接改 worker/index.ts(wire 阶段统一挂)。

import { decodeBase64Xml, setSamlEngine, verifySamlResponse } from '@xid-kit/saml'
import { resolveTenantContextByApplicationClientId } from '@xid-kit/db'
import { DEFAULT_SESSION_POLICY, defaultLandingPathFor, normalizeLocalPath } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError, isAppError } from '../lib/errors'
import { renderProtocolErrorPage } from '../lib/error-page'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession } from '../lib/session'
import { SSO_AUTH_CONTEXT } from '../lib/auth-context'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import type { XidHonoEnv } from '../lib/types'
import { samlErrorToApp } from './saml-errors'
import { acsUrl, loadSpDecryptKey, resolveConnection, spEntityId } from './saml-connection'
import type { SamlConnection } from './saml-connection'
import { shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
import { readUniqueSamlFormField } from './saml-binding-input'
import { jitProvision } from './jit'
import { requestHasRawInvitationInput, withSignInErrorRedirect } from '../lib/federated-flow'
import {
  consumeAuthnRequestContext,
  isAssertionReplay,
  storeAuthnRequestId,
  storeInboundSamlSessionIndex,
} from './saml-do'
import type { SamlAuthnRequestContext } from './saml-do'
import { buildSpMetadata, redirectToIdp } from './saml-views'
import { resolveSsoConnectionTenant, withTenant } from './tenant'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'
import {
  isAuthorizeContinuation,
  isInvitationContinuation,
  resolveApplicationAuthorizeContinuation,
} from '../../shared/hosted-auth-continuation'
import { isApplicationSignUpIntent } from '../../shared/hosted-auth-intent'
import { acsFormSchema, parseShape } from './saml-form'
import { resolveRelayState, samlAssertionToSso, toAttributeMapping } from './saml-acs-mapping'
import { handleInboundSlo } from './saml-slo'

export { resolveRelayState, toAttributeMapping } from './saml-acs-mapping'

const saml = new Hono<XidHonoEnv>()

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
  if (isInvitationContinuation(flow.continuePath)) {
    throw new AppError('invalid_request')
  }
  const tenant = c.get('tenant')
  if (flow.tenantId && flow.tenantId !== tenant.tenantId) {
    throw new AppError('cross_tenant_access_denied')
  }
  if (normalizeLocalPath(flow.continuePath) !== flow.continuePath) {
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
  if (isInvitationContinuation(relayState)) {
    throw new AppError('invalid_request')
  }

  const assertion = await verifyAcs(c, connection, samlResponse)
  const requestFlow = await checkInResponseTo(c, connectionId, assertion.inResponseTo)

  if (await isAssertionReplay(c, connectionId, assertion.assertionId, assertion.notOnOrAfter)) {
    throw new AppError('replay_detected', { httpStatus: 403 })
  }

  const relayTarget = requestFlow
    ? new URL(requestFlow.continuePath, c.get('tenant').issuer).toString()
    : resolveRelayState(c.get('tenant'), relayState, connection.relayStateUrl)
  const defaultLandingPath = defaultLandingPathFor(c.get('tenant'))
  const localRelayTarget = relayTarget.startsWith(c.get('tenant').issuer)
    ? relayTarget.slice(c.get('tenant').issuer.length) || defaultLandingPath
    : defaultLandingPath
  if (!requestFlow && isAuthorizeContinuation(localRelayTarget)) {
    throw new AppError('invalid_request')
  }
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin: localRelayTarget,
  })
  const { userId } = await jitProvision(
    c,
    samlAssertionToSso(connection, assertion.subject, assertion.attributes),
    { skipDefaultMembership },
  )

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

// GET/POST /sso/saml/:connection/slo -- 入站 SAML SLO(LogoutRequest -> 撤销 session -> LogoutResponse)。
saml.get('/saml/:connection/slo', handleInboundSlo)
saml.post('/saml/:connection/slo', handleInboundSlo)

// GET /sso/saml/:connection/login -- SP-initiated AuthnRequest 发起(302 到 IdP SSO URL)。
// 浏览器顶层导航:预期失败回 /sign-in?error=<不透明码>。
saml.get('/saml/:connection/login', async (c) =>
  withSignInErrorRedirect(c, {
    operation: 'saml_login',
    context: () => ({
      continuePath: c.req.query('relay_state') ?? c.req.query('continue') ?? null,
      applicationClientId: c.req.query('client_id')?.trim() || null,
      intent: c.req.query('intent') ?? null,
    }),
    run: () => startSamlLogin(c),
  }),
)

async function startSamlLogin(c: Context<XidHonoEnv>): Promise<Response> {
  if (requestHasRawInvitationInput(c, ['relay_state', 'RelayState', 'redirect_uri', 'continue'])) {
    throw new AppError('invalid_request')
  }
  const connectionId = c.req.param('connection')
  if (!connectionId) throw new AppError('connection_not_found')
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })

    const connection = await resolveConnection(c, connectionId)
    const rawContinue =
      c.req.query('relay_state') ?? c.req.query('continue') ?? defaultLandingPathFor(tenant)
    const applicationClientId = c.req.query('client_id')?.trim() || null
    const applicationContinuation = applicationClientId
      ? resolveApplicationAuthorizeContinuation(rawContinue, applicationClientId)
      : null
    const continuePath = applicationContinuation ?? normalizeLocalPath(rawContinue)
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
}

// 注册 SAML SP 路由(wire 阶段统一挂载;前缀 /sso)。
export function registerSamlRoutes(app: Hono<XidHonoEnv>): void {
  setSamlEngine(globalThis.crypto)
  app.route('/sso', saml)
}
