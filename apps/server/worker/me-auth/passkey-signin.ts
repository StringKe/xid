// 发现式 passkey 登录:challenge handle 用响应体 sessionId;四验证 + sign_count 无跳过。
// 凭证不存在与验签失败同 invalid_credentials。

import { base64UrlDecode, base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextById, schema } from '@xid-kit/db'
import { verifyAuthentication } from '@xid-kit/webauthn'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { PASSKEY_AUTH_CONTEXT } from '../lib/auth-context'
import { postAuthRedirectPath, resolvePostAuthMfaGate } from '../lib/mfa-session'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { firstIssuePath, readJsonBody, validateCredentialBody } from '../lib/validate'
import {
  buildStoredCredential,
  consumeChallenge,
  createChallenge,
  persistSignCount,
} from '../auth/passkey-helpers'
import { requestIp, requestUserAgent, verifyTurnstile } from './shared'
import { assertMethodAllowed, assertTenantResolvedForWebAuthn } from '../auth/hosted-policy'
import { auditPolicyDeniedError } from '../auth/hosted-audit'
import { loginHintCandidates, resolveEntryTenant, withTenant } from './instance-login'

// challenge DO key:per 匿名 ceremony,用前端原样回传的 sessionId(不透明 handle)。
function challengeKey(sessionId: string, tenantId: string): string {
  return `auth:${sessionId}:${tenantId}`
}

function webAuthnOrigins(tenant: TenantVar, requestOrigin: string): string[] {
  return [
    ...new Set([
      tenant.issuer,
      `https://${tenant.rpId}`,
      hostedAuthOriginForTenant(tenant, requestOrigin),
      requestOrigin,
    ]),
  ]
}

function decodeWebAuthnBytes(value: string): Uint8Array {
  try {
    return base64UrlDecode(value)
  } catch {
    throw new AppError('invalid_credentials')
  }
}

const verifyBodySchema = v.object({
  organizationId: v.optional(v.string()),
  clientId: v.optional(v.string()),
  turnstileToken: v.optional(v.nullable(v.string())),
  sessionId: v.string(),
  id: v.optional(v.string()),
  rawId: v.string(),
  type: v.optional(v.string()),
  response: v.object({
    clientDataJSON: v.string(),
    authenticatorData: v.string(),
    signature: v.string(),
    userHandle: v.optional(v.nullable(v.string())),
  }),
})

const challengeBodySchema = v.object({
  identifier: v.optional(v.string()),
  organizationId: v.optional(v.nullable(v.string())),
  clientId: v.optional(v.nullable(v.string())),
})

async function resolvePasskeyChallengeTenant(c: Context<XidHonoEnv>): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!current.resolution?.unresolvedRoot) return current
  // challenge 阶段不触达凭证存在性,body 仅用于 tenant 解析:坏 JSON 按 {} 处理,
  // 形状失败走 validation_failed(此处 422 不泄露任何账户信息)。
  const json = await readJsonBody(c)
  const parsed = v.safeParse(challengeBodySchema, json.ok ? json.value : {})
  if (!parsed.success) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: firstIssuePath(parsed.issues) },
    })
  }
  const body = parsed.output
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

async function resolvePasskeyVerifyTenant(
  c: Context<XidHonoEnv>,
  organizationId: string | undefined,
  applicationClientId: string | undefined,
): Promise<TenantVar> {
  if (applicationClientId?.trim()) {
    return resolveEntryTenant(c, [], organizationId, { applicationClientId })
  }
  const current = c.get('tenant')
  if (!current.resolution?.unresolvedRoot) return current
  if (!organizationId) return current
  const result = await resolveTenantContextById(c.req.raw, c.env, organizationId)
  if (!result.ok) throw new AppError('cross_tenant_access_denied')
  return result.value.tenant
}

export async function handlePasskeyChallenge(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = await resolvePasskeyChallengeTenant(c)
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
  // sessionId 是不透明 challenge handle(非登录 session);前端原样回传到 verify。
  const sessionId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  const challenge = await createChallenge(c.env, challengeKey(sessionId, tenant.tenantId))
  return c.json({ challenge, sessionId, organizationId: tenant.tenantId })
}

// 四验证编排:消费 challenge(按 sessionId)+ 查凭证 + verifyAuthentication + sign_count 持久化。
// 查不到凭证与验签失败返回相同 invalid_credentials(枚举防护)。返回凭证绑定 userId。
async function verifyAssertion(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  sessionId: string
  credentialIdBase64: string
  response: { clientDataJSON: string; authenticatorData: string; signature: string }
}): Promise<string> {
  const { c, tenant, sessionId, credentialIdBase64, response } = opts
  const challengeVal = await consumeChallenge(c.env, challengeKey(sessionId, tenant.tenantId))
  if (!challengeVal) throw new AppError('challenge_invalid')

  const db = createTenantDb(c.env.DB, tenant)
  const cred = await db.passkeyCredentials.findOne(
    and(
      eq(schema.passkeyCredentials.credentialId, credentialIdBase64),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
  )
  const stored = cred ? buildStoredCredential(cred) : undefined

  const result = await verifyAuthentication({
    ceremony: 'authentication',
    expectedChallenge: decodeWebAuthnBytes(challengeVal),
    expectedRpId: tenant.rpId,
    expectedOrigins: webAuthnOrigins(tenant, new URL(c.req.url).origin),
    clientDataJson: decodeWebAuthnBytes(response.clientDataJSON),
    authenticatorData: decodeWebAuthnBytes(response.authenticatorData),
    signature: decodeWebAuthnBytes(response.signature),
    storedCredential: stored,
  })
  if (!result.ok || !cred) throw new AppError('invalid_credentials')

  await persistSignCount({
    env: c.env,
    tenantId: tenant.tenantId,
    cred: { userId: cred.userId, signCount: cred.signCount, credentialId: credentialIdBase64 },
    newSignCount: result.value.signCount,
    signCountAnomaly: result.value.signCountAnomaly,
    db,
  })
  return cred.userId
}

export async function handlePasskeyVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_credentials')
  // assertion 各字段(含嵌套 response)都是凭证:形状失败与验签失败同 invalid_credentials。
  const body = validateCredentialBody(verifyBodySchema, json.value, {
    code: 'invalid_credentials',
    credentialFields: ['sessionId', 'rawId', 'id', 'type', 'response'],
  })
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

  const sessionId = body.sessionId
  const credentialIdBase64 = body.rawId
  const assertionResponse = {
    clientDataJSON: body.response.clientDataJSON,
    authenticatorData: body.response.authenticatorData,
    signature: body.response.signature,
  }

  // 失败限流:credentialId 账户级 10/15min + IP 级 50/min(anti-abuse rule)。
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'passkey',
    account: credentialIdBase64 || null,
    ip: requestIp(c),
  })

  return withTenant(c, tenant, async () => {
    const userId = await verifyAssertion({
      c,
      tenant,
      sessionId,
      credentialIdBase64,
      response: assertionResponse,
    })

    const now = new Date()
    const returnPath = postAuthRedirectPath({})
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId,
      returnPath,
      sessionAmr: PASSKEY_AUTH_CONTEXT.amr,
    })
    await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: PASSKEY_AUTH_CONTEXT,
      authenticatedAt: now,
      rememberMe: true,
      ip: requestIp(c),
      userAgent: requestUserAgent(c),
    })

    return c.json(mfaGate.redirectUrl ? { redirectUrl: mfaGate.redirectUrl } : {})
  })
}
