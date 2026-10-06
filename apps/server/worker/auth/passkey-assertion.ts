// WebAuthn 认证 assertion 的唯一编排:消费 challenge -> 查凭证 -> 四验证 -> userHandle 核对 -> sign_count 持久化。
// 登录与 MFA / step-up 共用;凭证不存在、userHandle 不符与验签失败统一 invalid_credentials(枚举防护)。

import { base64UrlDecode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { verifyAuthentication } from '@xid-kit/webauthn'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { hostedAuthOriginForTenant } from '../lib/hosted-origin'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { buildStoredCredential, consumeChallenge, persistSignCount } from './passkey-helpers'

export type PasskeyAssertionResponse = {
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle?: string | null
}

type PasskeyCredentialRow = typeof schema.passkeyCredentials.$inferSelect

type VerifiedAuthentication = Extract<
  Awaited<ReturnType<typeof verifyAuthentication>>,
  { ok: true }
>['value']

export type VerifiedPasskeyAssertion = {
  credential: PasskeyCredentialRow
  verification: VerifiedAuthentication
}

export function webAuthnOrigins(tenant: TenantVar, requestOrigin: string): string[] {
  return [
    ...new Set([
      tenant.issuer,
      `https://${tenant.rpId}`,
      hostedAuthOriginForTenant(tenant, requestOrigin),
      requestOrigin,
    ]),
  ]
}

export function decodeWebAuthnBytes(value: string): Uint8Array {
  try {
    return base64UrlDecode(value)
  } catch {
    throw new AppError('invalid_credentials')
  }
}

// 注册时 user.id = base64url(utf8(userId));发现式凭证回传的 userHandle 必须指向同一用户(WebAuthn §7.2 step 6)。
function userHandleMatches(userHandle: string | null | undefined, userId: string): boolean {
  if (!userHandle) return true
  return new TextDecoder().decode(decodeWebAuthnBytes(userHandle)) === userId
}

export async function verifyPasskeyAssertion(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  challengeKey: string
  credentialId: string
  response: PasskeyAssertionResponse
  userId?: string
}): Promise<VerifiedPasskeyAssertion> {
  const { c, tenant, db, challengeKey, credentialId, response, userId } = opts
  const challengeVal = await consumeChallenge(c.env, challengeKey)
  if (!challengeVal) throw new AppError('challenge_invalid')

  const credential = await db.passkeyCredentials.findOne(
    and(
      eq(schema.passkeyCredentials.credentialId, credentialId),
      isNull(schema.passkeyCredentials.revokedAt),
      ...(userId ? [eq(schema.passkeyCredentials.userId, userId)] : []),
    ),
  )
  const result = await verifyAuthentication({
    ceremony: 'authentication',
    expectedChallenge: decodeWebAuthnBytes(challengeVal),
    expectedRpId: tenant.rpId,
    expectedOrigins: webAuthnOrigins(tenant, new URL(c.req.url).origin),
    clientDataJson: decodeWebAuthnBytes(response.clientDataJSON),
    authenticatorData: decodeWebAuthnBytes(response.authenticatorData),
    signature: decodeWebAuthnBytes(response.signature),
    storedCredential: credential ? buildStoredCredential(credential) : undefined,
  })
  if (!result.ok || !credential) throw new AppError('invalid_credentials')
  if (!userHandleMatches(response.userHandle, credential.userId)) {
    throw new AppError('invalid_credentials')
  }

  await persistSignCount({
    env: c.env,
    tenantId: tenant.tenantId,
    cred: {
      userId: credential.userId,
      signCount: credential.signCount,
      credentialId,
    },
    newSignCount: result.value.signCount,
    signCountAnomaly: result.value.signCountAnomaly,
    db,
  })
  return { credential, verification: result.value }
}
