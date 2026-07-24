// 测试用 ES256 密钥与 token 工坊:直接 generateKey + crypto signJwt,自包含不依赖 KEK/信封加密。
import type { PublicJwk } from '@xid-kit/crypto'
import { exportPublicJwk, signJwt } from '@xid-kit/crypto'

export type TestKey = {
  kid: string
  signingKey: CryptoKey
  publicJwk: PublicJwk
}

export async function makeEs256Key(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = await exportPublicJwk(pair.publicKey, kid, 'ES256')
  return { kid, signingKey: pair.privateKey, publicJwk }
}

export async function mintToken(
  key: TestKey,
  payload: Record<string, unknown>,
  typ = 'at+jwt',
): Promise<string> {
  return signJwt({ header: { alg: 'ES256', kid: key.kid, typ }, payload }, key.signingKey)
}
