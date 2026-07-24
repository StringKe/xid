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
  ACR_AAL3,
  buildPasskeyMfaAuthContext,
  PASSWORD_AUTH_CONTEXT,
  type AuthAssuranceLevel,
  type AuthContextData,
} from '../lib/auth-context'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { readSession } from '../lib/session'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { parseAuthzRequestId, peekStashedAuthorizeParams } from '../oidc/pending-params'
import { readJsonBody, validateCredentialBody, validateQuery } from '../lib/validate'
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
  requireAal3: v.optional(v.boolean()),
  authzRequestId: v.optional(v.string()),
  redirectTo: v.optional(v.string()),
})

type PasskeyMfaVerifyBody = v.InferOutput<typeof passkeyMfaVerifyBodySchema>

const authzRequestIdQuerySchema = v.object({ authz_request_id: v.optional(v.string()) })

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

function stashedParamsRequireAal3(params: Record<string, string>): boolean {
  if (params['require_aal3'] === '1') return true
  const acrValues = params['acr_values'] ?? ''
  return acrValues.split(' ').filter(Boolean).includes(ACR_AAL3)
}

async function resolveRequireAal3(
  c: Context<XidHonoEnv>,
  body: PasskeyMfaVerifyBody,
): Promise<boolean> {
  const query = validateQuery(authzRequestIdQuerySchema, {
    authz_request_id: c.req.query('authz_request_id'),
  })
  const authzRequestId =
    body.authzRequestId ?? parseAuthzRequestId(body.redirectTo) ?? query.authz_request_id
  if (!authzRequestId) return false

  const tenant = c.get('tenant')
  const pending = await peekStashedAuthorizeParams(c.env, tenant.tenantId, authzRequestId)
  if (!pending) return false
  return stashedParamsRequireAal3(pending)
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

  const attestationMode = tenant.policy.hostedAuth?.attestationMode ?? 'none'
  const passkeyAssurance = {
    userVerified: result.value.userVerified,
    credentialBackedUp: result.value.credentialBackedUp,
    credentialDeviceType: result.value.credentialDeviceType,
    enterpriseAttestationVerified: cred.enterpriseAttestationVerified,
    requireEnterpriseAttestation: attestationMode === 'direct',
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

  const sessionAal = session.aal
  const base: AuthContextData = {
    acr: session.acr ?? PASSWORD_AUTH_CONTEXT.acr,
    amr: session.amr ?? PASSWORD_AUTH_CONTEXT.amr,
    aal:
      sessionAal === 1 || sessionAal === 2 || sessionAal === 3
        ? sessionAal
        : (1 as AuthAssuranceLevel),
  }
  const requireAal3 = await resolveRequireAal3(c, body)
  const nextAuthContext = requireAal3
    ? buildPasskeyMfaAuthContext(base, passkeyAssurance)
    : addMfaToAuthContext(base, 'passkey')

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
