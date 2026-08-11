// JWKS 输出全部未过期公钥(active/next/retiring 多 kid 并存),轮换期间验证不中断。

import type { SigningAlg, SigningKeyMaterial } from '@xid-kit/types'

export type PublicJwk = JsonWebKey & {
  kid: string
  use: 'sig'
  alg: SigningAlg
}

export type Jwks = {
  keys: PublicJwk[]
}

export async function exportPublicJwk(
  publicKey: CryptoKey,
  kid: string,
  alg: SigningAlg,
): Promise<PublicJwk> {
  // workers-types exportKey 返回联合类型,按 jwk format 断言。
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey
  return { ...jwk, kid, use: 'sig', alg }
}

function materialToJwk(material: SigningKeyMaterial): PublicJwk {
  return { ...material.publicKeyJwk, kid: material.kid, use: 'sig', alg: material.alg }
}

// retiring 公钥保留到旧 token 过期后再由 planRotation retire_old 删除。
export function buildJwks(materials: readonly SigningKeyMaterial[]): Jwks {
  return { keys: materials.map(materialToJwk) }
}

export async function importJwkForVerify(jwk: PublicJwk): Promise<CryptoKey> {
  const params: SubtleCryptoImportKeyAlgorithm =
    jwk.alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: jwk.alg === 'RS256' ? 'RSASSA-PKCS1-v1_5' : 'RSA-PSS', hash: 'SHA-256' }
  return crypto.subtle.importKey('jwk', jwk, params, true, ['verify'])
}
