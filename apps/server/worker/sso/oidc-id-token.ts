// 上游企业 IdP 的 id_token 校验与 claims -> SsoAssertion 映射。

import { verifyJwt } from '@xid-kit/crypto'
import type { VerifyKeySet } from '@xid-kit/crypto'
import { AppError } from '../lib/errors'
import type { SsoAssertion } from './jit'

type VerifyIdTokenParams = {
  idToken: string
  keySet: VerifyKeySet
  expectedIssuer: string
  expectedAudience: string
  expectedNonce: string
}

// 验证 id_token 并返回 claims(签名 + nonce + sub)。
export async function verifyIdToken(p: VerifyIdTokenParams): Promise<Record<string, unknown>> {
  const result = await verifyJwt(p.idToken, p.keySet, {
    expectedIssuer: p.expectedIssuer,
    expectedAudience: p.expectedAudience,
  })
  if (!result.ok) {
    throw new AppError('signature_invalid', {
      longMessage: `id_token verification failed: ${result.error.reason}`,
    })
  }
  const claims = result.value.payload as Record<string, unknown>
  if (claims['nonce'] !== p.expectedNonce) {
    throw new AppError('signature_invalid', { longMessage: 'nonce_mismatch' })
  }
  if (typeof claims['sub'] !== 'string' || !claims['sub']) {
    throw new AppError('malformed_request', { longMessage: 'id_token missing sub' })
  }
  return claims
}

// 从 OIDC id_token claims 中提取 SsoAssertion。
export function claimsToAssertion(
  claims: Record<string, unknown>,
  connectionId: string,
  orgId: string,
): SsoAssertion {
  const gc = claims['groups']
  return {
    idpId: typeof claims['sub'] === 'string' ? claims['sub'] : '',
    connectionId,
    orgId,
    email: typeof claims['email'] === 'string' ? claims['email'] : null,
    emailVerified: claims['email_verified'] === true,
    firstName: typeof claims['given_name'] === 'string' ? claims['given_name'] : null,
    lastName: typeof claims['family_name'] === 'string' ? claims['family_name'] : null,
    // groups claim(Microsoft Entra / Okta 可选,见 04 章 6)。
    groups: Array.isArray(gc) ? gc.filter((g): g is string => typeof g === 'string') : [],
    customAttributes: {},
  }
}
