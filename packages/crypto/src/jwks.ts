// JWKS 构建(见 signing-keys rule:/jwks 多 kid 并存,输出所有未过期公钥,轮换不中断验证)。
// 公钥 JWK 直接来自 exportKey('jwk') 或落库的 SigningKeyMaterial.publicKeyJwk(08 章 16.3)。

import type { SigningAlg, SigningKeyMaterial } from '@xid-kit/types'

// 标准 JWK 公钥 + JWKS 元字段(use/kid/alg,RFC7517)。
export type PublicJwk = JsonWebKey & {
  kid: string
  use: 'sig'
  alg: SigningAlg
}

export type Jwks = {
  keys: PublicJwk[]
}

// 从公钥 CryptoKey 导出带 kid/use/alg 的 JWK(JWKS 单条)。
export async function exportPublicJwk(
  publicKey: CryptoKey,
  kid: string,
  alg: SigningAlg,
): Promise<PublicJwk> {
  // exportKey 返回 ArrayBuffer | JsonWebKey 联合,按 'jwk' format 收窄为 JsonWebKey。
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey
  return { ...jwk, kid, use: 'sig', alg }
}

// 用已落库的 SigningKeyMaterial.publicKeyJwk 组装单条 JWK(无需重新导出)。
function materialToJwk(material: SigningKeyMaterial): PublicJwk {
  return { ...material.publicKeyJwk, kid: material.kid, use: 'sig', alg: material.alg }
}

// 构建 JWKS:输出 active/next/retiring 全部未过期公钥(多 kid 并存,见 signing-keys rule 四步轮换)。
// retiring 仍在 JWKS 内,直到旧 token 过期后才物理删除(planRotation retire_old)。
export function buildJwks(materials: readonly SigningKeyMaterial[]): Jwks {
  return { keys: materials.map(materialToJwk) }
}

// 把 JWKS 中的公钥 JWK 导入为 verify CryptoKey(SDK networkless 验证侧用,见 api-sdk-conventions rule)。
export async function importJwkForVerify(jwk: PublicJwk): Promise<CryptoKey> {
  const params: SubtleCryptoImportKeyAlgorithm =
    jwk.alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: jwk.alg === 'RS256' ? 'RSASSA-PKCS1-v1_5' : 'RSA-PSS', hash: 'SHA-256' }
  return crypto.subtle.importKey('jwk', jwk, params, true, ['verify'])
}
