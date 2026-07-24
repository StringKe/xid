// 测试用 ES256 密钥与 token 工坊:自包含,不依赖 KEK/信封加密。
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

export async function mintAccessToken(
  key: TestKey,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: 'ES256', kid: key.kid, typ: 'at+jwt' },
      payload: {
        iss: 'https://test.xid.dev',
        sub: 'user_test',
        aud: 'client_test',
        azp: 'client_test',
        sid: 'sess_test',
        exp: nowSec + 3600,
        iat: nowSec - 5,
        nbf: nowSec - 5,
        jti: 'jti_test',
        scope: 'openid',
        client_id: 'client_test',
        ...overrides,
      },
    },
    key.signingKey,
  )
}

export async function mintExpiredToken(key: TestKey): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  // exp 必须越过 verifyJwt 默认 60s clock tolerance(判定为 now > exp + 60),取 now - 120。
  return mintAccessToken(key, { exp: nowSec - 120, iat: nowSec - 3720, nbf: nowSec - 3720 })
}
