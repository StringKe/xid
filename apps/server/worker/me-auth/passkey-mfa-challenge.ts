// POST /auth/mfa/passkey/options + /auth/mfa/passkey/verify
// Passkey 第二因子:UV required,fresh challenge DO,与主 passkey 登录路径分离(NIST MFA)。

import { base64UrlDecode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { verifyAuthentication } from '@xid-kit/webauthn'
import { and, eq, isNull } from 'drizzle-orm'
import { setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import * as v from 'valibot'
import {
  buildStoredCredential,
  CHALLENGE_TTL_MS,
  consumeChallenge,
  createChallenge,
  persistSignCount,
} from '../auth/passkey-helpers'
import { listEligiblePasskeyCredentials } from '../auth/passkey-mfa-eligibility'
import { issueStepUpToken } from '../auth/mfa'
import { AppError } from '../lib/errors'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import {
  addMfaToAuthContext,
  normalizeAuthAssuranceLevel,
  normalizeIssuedAcr,
  PASSWORD_AUTH_CONTEXT,
  type AuthContextData,
} from '../lib/auth-context'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { readSession } from '../lib/session'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import { requestIp } from './shared'

const STEP_UP_TTL_SEC = 5 * 60

const passkeyMfaVerifyBodySchema = v.object({
  id: v.optional(v.string()),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.string(),
    authenticatorData: v.string(),
    signature: v.string(),
  }),
  stepUp: v.optional(v.boolean()),
})

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

async function requireMfaSession(c: Context<XidHonoEnv>): Promise<SessionData> {
  const current = c.get('session')
  if (current) return current
  const session = await readSession(c, ['active', 'pending_mfa'])
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  c.set('session', session)
  return session
}

function challengeKey(sessionId: string, tenantId: string): string {
  return `mfa:${sessionId}:${tenantId}`
}

export async function handlePasskeyMfaOptions(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireMfaSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const credentials = await listEligiblePasskeyCredentials(db, session)
  if (credentials.length === 0) throw new AppError('mfa_setup_required')

  const challenge = await createChallenge(c.env, challengeKey(session.sessionId, tenant.tenantId))
  return c.json({
    challenge,
    rpId: tenant.rpId,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: credentials.map((cred) => ({
      id: cred.credentialId,
      type: 'public-key',
      transports: cred.transports,
    })),
  })
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
  const credentialIdBase64 = body.rawId
  const response = body.response

  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'passkey',
    account: credentialIdBase64,
    ip: requestIp(c),
  })

  const db = createTenantDb(c.env.DB, tenant)
  const eligible = await listEligiblePasskeyCredentials(db, session)
  if (!eligible.some((cred) => cred.credentialId === credentialIdBase64)) {
    throw new AppError('invalid_credentials')
  }

  const challengeVal = await consumeChallenge(
    c.env,
    challengeKey(session.sessionId, tenant.tenantId),
  )
  if (!challengeVal) throw new AppError('challenge_invalid')

  const cred = await db.passkeyCredentials.findOne(
    and(
      eq(schema.passkeyCredentials.credentialId, credentialIdBase64),
      eq(schema.passkeyCredentials.userId, session.userId),
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

  const passkeyAssurance = {
    userVerified: result.value.userVerified,
    credentialBackedUp: result.value.credentialBackedUp,
    credentialDeviceType: result.value.credentialDeviceType,
    enterpriseAttestationVerified: cred.enterpriseAttestationVerified,
  }

  if (body.stepUp === true) {
    const { token } = await issueStepUpToken({
      userId: session.userId,
      sessionId: session.sessionId,
      method: 'passkey',
      pepperRaw: c.env.PEPPER,
      passkeyAssurance: {
        userVerified: passkeyAssurance.userVerified,
        credentialBackedUp: passkeyAssurance.credentialBackedUp,
        credentialDeviceType: passkeyAssurance.credentialDeviceType,
        enterpriseAttestationVerified: passkeyAssurance.enterpriseAttestationVerified,
      },
    })
    setCookie(c, '__Host-xid.acr', token, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: STEP_UP_TTL_SEC,
    })
    return c.json({})
  }

  const base: AuthContextData = {
    acr: normalizeIssuedAcr(session.acr) ?? PASSWORD_AUTH_CONTEXT.acr,
    amr: session.amr ?? PASSWORD_AUTH_CONTEXT.amr,
    aal: normalizeAuthAssuranceLevel(session.aal) ?? 1,
  }
  const nextAuthContext = addMfaToAuthContext(base, 'passkey')

  await db.sessions.update(
    {
      status: 'active',
      lastActiveAt: new Date(),
      acr: nextAuthContext.acr,
      amr: [...nextAuthContext.amr],
      aal: nextAuthContext.aal,
    },
    eq(schema.sessions.id, session.sessionId),
  )
  return c.json({})
}
