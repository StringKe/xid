// POST /auth/mfa/passkey/options + /auth/mfa/passkey/verify
// Passkey 第二因子与 step-up:UV required,独立 challenge key,与主 passkey 登录路径分离(NIST MFA)。

import { createTenantDb } from '@xid-kit/db'
import type { Context } from 'hono'
import * as v from 'valibot'
import { CHALLENGE_TTL_MS, createChallenge } from '../auth/passkey-helpers'
import { verifyPasskeyAssertion } from '../auth/passkey-assertion'
import { listEligiblePasskeyCredentials } from '../auth/passkey-mfa-eligibility'
import { AppError } from '../lib/errors'
import { completeMfaOnSession, requireMfaSession } from '../lib/mfa-session'
import { issueStepUpCookie } from '../lib/step-up'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import type { XidHonoEnv } from '../lib/types'
import { MFA_VERIFY_SCOPE } from './mfa-challenge'
import { earlierPasskeyRpId, isEarlierPasskey } from '../auth/passkey-rp-ids'
import { passkeyCeremonyOrigin } from './passkey-handoff'
import { handoffPrepareUrl, readHandoffContinue } from './passkey-handoff-paths'
import { requestIp } from './shared'

const passkeyMfaVerifyBodySchema = v.object({
  id: v.optional(v.string()),
  rawId: v.pipe(v.string(), v.minLength(1)),
  response: v.object({
    clientDataJSON: v.pipe(v.string(), v.minLength(1)),
    authenticatorData: v.pipe(v.string(), v.minLength(1)),
    signature: v.pipe(v.string(), v.minLength(1)),
    userHandle: v.optional(v.nullable(v.string())),
  }),
  stepUp: v.optional(v.boolean()),
})

function challengeKey(sessionId: string, tenantId: string): string {
  return `mfa:${sessionId}:${tenantId}`
}

const MFA_PATH = '/mfa'

// 不在组织 rpId 主机上时返回交接地址:会话(含待 MFA 状态)带到组织主机完成第二因子。
// earlier=true 时以实例主域为 rpId,只列早期在根域登记的凭证。
export async function handlePasskeyMfaOptions(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireMfaSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const credentials = await listEligiblePasskeyCredentials(db, session)
  if (credentials.length === 0) throw new AppError('mfa_setup_required')
  const ceremonyOrigin = passkeyCeremonyOrigin(c, tenant)
  if (ceremonyOrigin) {
    const continuePath = await readHandoffContinue(c, MFA_PATH)
    return c.json({ handoff: { url: handoffPrepareUrl(c, ceremonyOrigin, continuePath) } })
  }

  const earlierRpId = earlierPasskeyRpId(tenant)
  const earlierCredentials = credentials.filter((cred) => isEarlierPasskey(tenant, cred))
  const useEarlier = (await readEarlierFlag(c)) && earlierRpId !== null
  const offered = useEarlier ? earlierCredentials : credentials
  if (offered.length === 0) throw new AppError('mfa_setup_required')
  const challenge = await createChallenge(c.env, challengeKey(session.sessionId, tenant.tenantId))
  return c.json({
    challenge,
    rpId: useEarlier ? earlierRpId : tenant.rpId,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
    earlierAvailable: earlierRpId !== null && earlierCredentials.length > 0,
    allowCredentials: offered.map((cred) => ({
      id: cred.credentialId,
      type: 'public-key',
      transports: cred.transports,
    })),
  })
}

async function readEarlierFlag(c: Context<XidHonoEnv>): Promise<boolean> {
  const json = await readJsonBody(c)
  if (!json.ok || typeof json.value !== 'object' || json.value === null) return false
  return (json.value as { earlier?: unknown }).earlier === true
}

export async function handlePasskeyMfaVerify(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireMfaSession(c)
  const tenant = c.get('tenant')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('invalid_credentials')
  // assertion 字段(rawId/response)是凭证:形状失败与验签失败同 invalid_credentials。
  const body = validateCredentialBody(passkeyMfaVerifyBodySchema, json.value, {
    code: 'invalid_credentials',
    credentialFields: ['rawId', 'id', 'response'],
  })

  // 与 TOTP / SMS / 备份码共用 mfa 计数:第二因子不与主 passkey 登录互相累加。
  const rateLimitAccount = { env: c.env, tenantId: tenant.tenantId, scope: MFA_VERIFY_SCOPE }
  await enforceVerifyRateLimit({ ...rateLimitAccount, account: session.userId, ip: requestIp(c) })

  const db = createTenantDb(c.env.DB, tenant)
  const eligible = await listEligiblePasskeyCredentials(db, session)
  if (!eligible.some((cred) => cred.credentialId === body.rawId)) {
    throw new AppError('invalid_credentials')
  }

  const { credential, verification } = await verifyPasskeyAssertion({
    c,
    tenant,
    db,
    challengeKey: challengeKey(session.sessionId, tenant.tenantId),
    credentialId: body.rawId,
    response: body.response,
    userId: session.userId,
  })
  await resetVerifyAccountRateLimit({ ...rateLimitAccount, account: session.userId })

  if (body.stepUp === true) {
    await issueStepUpCookie(c, {
      session,
      method: 'passkey',
      passkeyAssurance: {
        userVerified: verification.userVerified,
        credentialBackedUp: verification.credentialBackedUp,
        credentialDeviceType: verification.credentialDeviceType,
        enterpriseAttestationVerified: credential.enterpriseAttestationVerified,
      },
    })
    return c.json({})
  }
  await completeMfaOnSession(c, tenant, { session, method: 'passkey' })
  return c.json({})
}
