// 协议测试从 TenantContext 取 issuer/签名密钥,验证内核不依赖全局单例。

import type { TenantContext } from '@xid-kit/types'
import { generateTenantSigningKey } from '@xid-kit/crypto'

export type TestTenant = {
  ctx: TenantContext
  signingKey: CryptoKey
}

export async function buildTestTenant(
  options: { tenantId?: string; issuer?: string; kid?: string } = {},
): Promise<TestTenant> {
  const tenantId = options.tenantId ?? 'tenant_test'
  const issuer = options.issuer ?? 'https://test.xid.dev'
  const kid = options.kid ?? 'kid-test-001'
  const kekRaw = crypto.getRandomValues(new Uint8Array(32))
  const { material, signingKey } = await generateTenantSigningKey({
    kid,
    kekRaw,
    kekVersion: 1,
    alg: 'ES256',
    status: 'active',
  })
  const ctx: TenantContext = {
    tenantId,
    issuer,
    rpId: 'test.xid.dev',
    signingKeys: { activeKid: kid, defaultAlg: 'ES256', keys: [material] },
    policy: {},
  }
  return { ctx, signingKey }
}
