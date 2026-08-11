// 合法 JWT 用 Web Crypto(ES256)真算;过期/jti 重放样本为预定义常量。

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlEncodeStr(s: string): string {
  const bytes = new TextEncoder().encode(s)
  return base64UrlEncode(bytes)
}

function base64UrlDecodeToBytes(s: string): Uint8Array {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  const bstr = atob(padded)
  const bytes = new Uint8Array(bstr.length)
  for (let i = 0; i < bstr.length; i++) {
    bytes[i] = bstr.charCodeAt(i)
  }
  return bytes
}

export type JwtPayload = {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  jti: string
  scope?: string
  client_id?: string
}

export async function generateEs256KeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
}

// 仅用于测试向量生成,不做业务校验。
export async function signJwt(
  payload: JwtPayload,
  privateKey: CryptoKey,
  kid: string,
): Promise<string> {
  const header = base64UrlEncodeStr(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }))
  const body = base64UrlEncodeStr(JSON.stringify(payload))
  const signingInput = `${header}.${body}`
  const sigBytes = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  )
  const sig = base64UrlEncode(new Uint8Array(sigBytes))
  return `${signingInput}.${sig}`
}

export function decodeJwtHeader(token: string): { alg: string; typ: string; kid?: string } {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0]) throw new Error('invalid JWT format')
  const raw = new TextDecoder().decode(base64UrlDecodeToBytes(parts[0]))
  return JSON.parse(raw) as { alg: string; typ: string; kid?: string }
}

export function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) throw new Error('invalid JWT format')
  const raw = new TextDecoder().decode(base64UrlDecodeToBytes(parts[1]))
  return JSON.parse(raw) as JwtPayload
}

export type ValidJwtVector = {
  description: string
  token: string
  payload: JwtPayload
  kid: string
  publicKey: CryptoKey
}

export async function buildValidJwtVectors(): Promise<ValidJwtVector[]> {
  const keyPair = await generateEs256KeyPair()
  const kid = 'test-kid-001'
  const now = Math.floor(Date.now() / 1000)

  const payloadAccess: JwtPayload = {
    iss: 'https://test.xid.dev',
    sub: 'user_test_001',
    aud: 'client_001',
    exp: now + 3600,
    iat: now,
    jti: 'jti-access-001',
    scope: 'openid profile email',
    client_id: 'client_001',
  }

  const payloadIdToken: JwtPayload = {
    iss: 'https://test.xid.dev',
    sub: 'user_test_001',
    aud: 'client_001',
    exp: now + 3600,
    iat: now,
    jti: 'jti-idtoken-001',
  }

  const [accessToken, idToken] = await Promise.all([
    signJwt(payloadAccess, keyPair.privateKey, kid),
    signJwt(payloadIdToken, keyPair.privateKey, kid),
  ])

  return [
    {
      description: 'valid access token with scope',
      token: accessToken,
      payload: payloadAccess,
      kid,
      publicKey: keyPair.publicKey,
    },
    {
      description: 'valid id token',
      token: idToken,
      payload: payloadIdToken,
      kid,
      publicKey: keyPair.publicKey,
    },
  ]
}

export type ExpiredJwtSample = {
  description: string
  // 预定义过期结构,不做真实签名验证。
  expiredPayload: JwtPayload
  expectedErrorCode: 'invalid_grant' | 'session_expired'
}

const PAST_TIME = 1700000000 // 2023-11-14,确定已过期

export const EXPIRED_JWT_SAMPLES: readonly ExpiredJwtSample[] = [
  {
    description: 'access token expired 1 hour ago',
    expiredPayload: {
      iss: 'https://test.xid.dev',
      sub: 'user_test_001',
      aud: 'client_001',
      exp: PAST_TIME,
      iat: PAST_TIME - 3600,
      jti: 'jti-expired-001',
      scope: 'openid',
    },
    expectedErrorCode: 'invalid_grant',
  },
  {
    description: 'session token expired (absolute timeout)',
    expiredPayload: {
      iss: 'https://test.xid.dev',
      sub: 'user_test_002',
      aud: 'client_002',
      exp: PAST_TIME - 86400,
      iat: PAST_TIME - 86400 * 32,
      jti: 'jti-session-expired-001',
    },
    expectedErrorCode: 'session_expired',
  },
]

// 相同 jti 二次使用应触发 family 吊销。
export type JtiReplaySample = {
  description: string
  jti: string
  expectedErrorCode: 'refresh_token_reused' | 'invalid_grant'
}

export const JTI_REPLAY_SAMPLES: readonly JtiReplaySample[] = [
  {
    description: 'refresh token jti reuse triggers family revocation',
    jti: 'refresh-jti-reused-001',
    expectedErrorCode: 'refresh_token_reused',
  },
  {
    description: 'authorization code jti reuse must be rejected',
    jti: 'auth-code-jti-reused-001',
    expectedErrorCode: 'invalid_grant',
  },
]

export { base64UrlEncodeStr, base64UrlDecodeToBytes }
