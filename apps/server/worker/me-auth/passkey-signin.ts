// 发现式 passkey 登录:challenge handle 用响应体 sessionId;四验证 + sign_count 无跳过。
// 凭证不存在与验签失败同 invalid_credentials。

import { base64UrlEncode } from '@xid-kit/crypto'
import {
  createTenantDb,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextById,
} from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { PASSKEY_AUTH_CONTEXT } from '../lib/auth-context'
import { postAuthRedirectPath, resolvePostAuthMfaGate } from '../lib/mfa-session'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { firstIssuePath, readJsonBody, validateCredentialBody } from '../lib/validate'
import { createChallenge } from '../auth/passkey-helpers'
import { earlierPasskeyRpId } from '../auth/passkey-rp-ids'
import { verifyPasskeyAssertion } from '../auth/passkey-assertion'
import { requestIp, requestUserAgent, verifyTurnstile } from './shared'
import { assertMethodAllowed, assertTenantResolvedForWebAuthn } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import {
  isInstanceEntryContext,
  loginHintCandidates,
  resolveEntryTenant,
  withTenant,
} from './instance-login'
import {
  handoffStateSchema,
  issuerOrigin,
  mintSessionHandoff,
  passkeyCeremonyOrigin,
  requestOrigin,
  setHandoffState,
} from './passkey-handoff'
import { handoffReturnPath, isAuthorizeContinuation } from './passkey-handoff-paths'

// challenge DO key:per 匿名 ceremony,用前端原样回传的 sessionId(不透明 handle)。
function challengeKey(sessionId: string, tenantId: string): string {
  return `auth:${sessionId}:${tenantId}`
}

const verifyBodySchema = v.object({
  organizationId: v.optional(v.string()),
  clientId: v.optional(v.string()),
  continue: v.optional(v.nullable(v.string())),
  intent: v.optional(v.nullable(v.string())),
  turnstileToken: v.optional(v.nullable(v.string())),
  handoffState: v.optional(v.nullable(handoffStateSchema)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  id: v.optional(v.string()),
  rawId: v.pipe(v.string(), v.minLength(1)),
  type: v.optional(v.string()),
  response: v.object({
    clientDataJSON: v.pipe(v.string(), v.minLength(1)),
    authenticatorData: v.pipe(v.string(), v.minLength(1)),
    signature: v.pipe(v.string(), v.minLength(1)),
    userHandle: v.optional(v.nullable(v.string())),
  }),
})

const challengeBodySchema = v.object({
  identifier: v.optional(v.string()),
  organizationId: v.optional(v.nullable(v.string())),
  clientId: v.optional(v.nullable(v.string())),
  // 在组织子域上以实例主域为 rpId 发起仪式,只用于早期在根域登记的 passkey。
  earlier: v.optional(v.boolean()),
})

type ChallengeBody = v.InferOutput<typeof challengeBodySchema>

// challenge 阶段不触达凭证存在性:坏 JSON 按 {} 处理,形状失败走 validation_failed(不泄露账户信息)。
async function readChallengeBody(c: Context<XidHonoEnv>): Promise<ChallengeBody> {
  const json = await readJsonBody(c)
  const parsed = v.safeParse(challengeBodySchema, json.ok ? json.value : {})
  if (!parsed.success) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: firstIssuePath(parsed.issues) },
    })
  }
  return parsed.output
}

async function resolvePasskeyChallengeTenant(
  c: Context<XidHonoEnv>,
  body: ChallengeBody,
): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!isInstanceEntryContext(current)) return current
  const selectedOrganizationId = body.organizationId?.trim()
  if (body.clientId?.trim()) {
    return resolveEntryTenant(c, [], selectedOrganizationId, {
      applicationClientId: body.clientId,
    })
  }
  if (selectedOrganizationId) {
    const result = await resolveTenantContextById(c.req.raw, c.env, selectedOrganizationId)
    if (!result.ok) throw new AppError('cross_tenant_access_denied')
    return result.value.tenant
  }
  const identifier = (body.identifier ?? '').trim()
  if (!identifier) return current
  return resolveEntryTenant(c, loginHintCandidates(identifier))
}

// 租户子域或自定义域上,WebAuthn 仪式的 RP ID 就是当前主机的 rpId:以当前主机的 TenantContext 为准,
// client_id 只核对归属。按 client_id 重新解析会得到根域上下文(rpId=实例主域),与仪式 rpIdHash 不符。
async function assertApplicationBelongsToTenant(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  applicationClientId: string,
): Promise<void> {
  const application = await resolveTenantContextByApplicationClientId(
    c.req.raw,
    c.env,
    applicationClientId,
  )
  if (!application.ok || application.value.tenantId !== tenant.tenantId) {
    throw new AppError('cross_tenant_access_denied')
  }
}

async function resolvePasskeyVerifyTenant(
  c: Context<XidHonoEnv>,
  organizationId: string | undefined,
  applicationClientId: string | undefined,
): Promise<TenantVar> {
  const current = c.get('tenant')
  const clientId = applicationClientId?.trim()
  if (!isInstanceEntryContext(current)) {
    if (organizationId && organizationId !== current.tenantId) {
      throw new AppError('cross_tenant_access_denied')
    }
    if (clientId) await assertApplicationBelongsToTenant(c, current, clientId)
    return current
  }
  if (clientId) {
    return resolveEntryTenant(c, [], organizationId, { applicationClientId: clientId })
  }
  if (!organizationId) return current
  const result = await resolveTenantContextById(c.req.raw, c.env, organizationId)
  if (!result.ok) throw new AppError('cross_tenant_access_denied')
  return result.value.tenant
}

export async function handlePasskeyChallenge(c: Context<XidHonoEnv>): Promise<Response> {
  const body = await readChallengeBody(c)
  const tenant = await resolvePasskeyChallengeTenant(c, body)
  try {
    assertTenantResolvedForWebAuthn(tenant)
    assertMethodAllowed(tenant, 'passkey', 'login')
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'passkey',
      action: 'login',
    })
  }
  // 根域解析出的组织 rpId 是其子域:不在这里发 challenge,让浏览器到 rpId 主机完成仪式。
  const ceremonyOrigin = passkeyCeremonyOrigin(c, tenant)
  if (ceremonyOrigin) {
    const state = setHandoffState(c)
    return c.json({ ceremony: { origin: ceremonyOrigin, state }, organizationId: tenant.tenantId })
  }
  // sessionId 是不透明 challenge handle(非登录 session);前端原样回传到 verify。
  const sessionId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  const challenge = await createChallenge(c.env, challengeKey(sessionId, tenant.tenantId))
  const earlierRpId = body.earlier ? earlierPasskeyRpId(tenant) : null
  return c.json({
    challenge,
    sessionId,
    organizationId: tenant.tenantId,
    ...(earlierRpId ? { rpId: earlierRpId } : {}),
  })
}

export async function handlePasskeyVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_credentials')
  // assertion 各字段(含嵌套 response)都是凭证:形状失败与验签失败同 invalid_credentials。
  const body = validateCredentialBody(verifyBodySchema, json.value, {
    code: 'invalid_credentials',
    credentialFields: ['sessionId', 'rawId', 'id', 'type', 'response'],
  })
  const flow = resolveHostedAuthFlow({
    intent: body.intent,
    continuePath: body.continue,
    applicationClientId: body.clientId,
    defaultContinuePath: defaultLandingPathFor(c.get('tenant')),
  })
  if (!flow) throw new AppError('invalid_request')
  await verifyTurnstile(body.turnstileToken, c.env, requestIp(c))
  const tenant = await resolvePasskeyVerifyTenant(c, body.organizationId, body.clientId)
  try {
    assertTenantResolvedForWebAuthn(tenant)
    assertMethodAllowed(tenant, 'passkey', 'login')
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'passkey',
      action: 'login',
    })
  }
  if (passkeyCeremonyOrigin(c, tenant)) throw new AppError('invalid_request')

  // 失败限流:credentialId 账户级 10/15min + IP 级 50/min(anti-abuse rule);成功后清除账户维度。
  const rateLimitAccount = { env: c.env, tenantId: tenant.tenantId, scope: 'passkey' }
  await enforceVerifyRateLimit({ ...rateLimitAccount, account: body.rawId, ip: requestIp(c) })

  return withTenant(c, tenant, async () => {
    const { credential } = await verifyPasskeyAssertion({
      c,
      tenant,
      db: createTenantDb(c.env.DB, tenant),
      challengeKey: challengeKey(body.sessionId, tenant.tenantId),
      credentialId: body.rawId,
      response: body.response,
    })
    await resetVerifyAccountRateLimit({ ...rateLimitAccount, account: body.rawId })
    const userId = credential.userId

    const now = new Date()
    const returnPath = postAuthRedirectPath({
      intent: flow.intent,
      continueParam: flow.continuePath,
      fallback: defaultLandingPathFor(tenant),
    })
    // 应用登录要回 issuer 主机续跑 /authorize;仍需 MFA 时先在本主机完成,再经返回入口交回。
    const returnsToIssuer =
      isAuthorizeContinuation(returnPath) && requestOrigin(c) !== issuerOrigin(tenant)
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId,
      returnPath: returnsToIssuer ? handoffReturnPath(returnPath) : returnPath,
      sessionAmr: PASSKEY_AUTH_CONTEXT.amr,
    })
    const issued = await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: PASSKEY_AUTH_CONTEXT,
      authenticatedAt: now,
      rememberMe: true,
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })

    if (returnsToIssuer && body.handoffState && !mfaGate.redirectUrl) {
      const handoff = await mintSessionHandoff(c, {
        tenant,
        targetOrigin: issuerOrigin(tenant),
        continuePath: returnPath,
        state: body.handoffState,
        session: {
          userId,
          status: issued.session.status,
          authenticatedAt: now,
          acr: PASSKEY_AUTH_CONTEXT.acr,
          amr: PASSKEY_AUTH_CONTEXT.amr,
          aal: PASSKEY_AUTH_CONTEXT.aal,
          rememberMe: true,
          stepUp: null,
        },
      })
      return c.json({ handoff })
    }
    const continuePath = returnsToIssuer ? handoffReturnPath(returnPath) : returnPath
    return c.json({ redirectUrl: mfaGate.redirectUrl ?? continuePath })
  })
}
