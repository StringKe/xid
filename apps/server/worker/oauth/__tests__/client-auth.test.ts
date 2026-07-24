// client-auth 单元测试:四种认证方法(basic/post/private_key_jwt/none)+ requireConfidential。
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { sha256Hex, signJwt, exportPublicJwk } from '@xid-kit/crypto'
import { authenticateClient } from '../lib/client-auth'
import type { XidHonoEnv } from '../../lib/types'
import { makeFakeD1, makeAppRow, makeTenant, makeEnv } from './mock-helpers'

const TENANT = makeTenant()

async function runAuth(
  env: Env,
  headers: Record<string, string>,
  body: string,
  opts?: { requireConfidential?: boolean },
): Promise<ReturnType<typeof authenticateClient> extends Promise<infer R> ? R : never> {
  const app = new Hono<XidHonoEnv>()
  let captured: Awaited<ReturnType<typeof authenticateClient>>
  app.post('/', async (c) => {
    c.set('tenant', TENANT)
    captured = await authenticateClient(c as Context<XidHonoEnv>, opts)
    return c.json({ ok: true })
  })
  const req = new Request('http://test.idx.dev/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  })
  await app.request(req, {}, env)
  return captured!
}

describe('client-auth: client_secret_basic', () => {
  it('正确 secret 认证成功', async () => {
    const secret = 'correct_secret'
    const hash = await sha256Hex(secret)
    const row = makeAppRow({
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_basic',
    })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const creds = btoa(`client_abc:${secret}`)
    const result = await runAuth(env, { authorization: `Basic ${creds}` }, 'client_id=client_abc')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.clientId).toBe('client_abc')
  })

  it('错误 secret 返回失败', async () => {
    const hash = await sha256Hex('correct_secret')
    const row = makeAppRow({
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_basic',
    })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const creds = btoa('client_abc:wrong_secret')
    const result = await runAuth(env, { authorization: `Basic ${creds}` }, 'client_id=client_abc')
    expect(result.ok).toBe(false)
  })
})

describe('client-auth: client_secret_post', () => {
  it('正确 secret post 认证成功', async () => {
    const secret = 'post_secret'
    const hash = await sha256Hex(secret)
    const row = makeAppRow({
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_post',
    })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const result = await runAuth(env, {}, `client_id=client_abc&client_secret=${secret}`)
    expect(result.ok).toBe(true)
  })

  it('缺少 secret 返回失败', async () => {
    const hash = await sha256Hex('some_secret')
    const row = makeAppRow({
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_post',
    })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const result = await runAuth(env, {}, 'client_id=client_abc')
    expect(result.ok).toBe(false)
  })
})

describe('client-auth: public client (none)', () => {
  it('none 方法不需要 secret', async () => {
    const row = makeAppRow({
      client_type: 'public',
      token_endpoint_auth_method: 'none',
      client_secret_hash: null,
    })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const result = await runAuth(env, {}, 'client_id=client_abc')
    expect(result.ok).toBe(true)
  })

  it('requireConfidential=true 时 public client 被拒', async () => {
    const row = makeAppRow({
      client_type: 'public',
      token_endpoint_auth_method: 'none',
      client_secret_hash: null,
    })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const result = await runAuth(env, {}, 'client_id=client_abc', { requireConfidential: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('confidential client required')
    }
  })
})

describe('client-auth: 不存在的 client', () => {
  it('未知 client_id 返回失败', async () => {
    const db = makeFakeD1({ apps: [] })
    const env = makeEnv(db)
    const result = await runAuth(env, {}, 'client_id=unknown_client')
    expect(result.ok).toBe(false)
  })
})

describe('client-auth: mTLS', () => {
  it.each(['tls_client_auth', 'self_signed_tls_client_auth'])(
    'accepts %s when mock TLS metadata matches subject DN',
    async (method) => {
      const row = makeAppRow({
        client_type: 'confidential',
        token_endpoint_auth_method: method,
        custom_claims_config: JSON.stringify({
          tlsClientAuthSubjectDn: 'CN=client.example.com',
        }),
      })
      const db = makeFakeD1({ apps: [row] })
      const env = makeEnv(db)
      const tlsHeader = JSON.stringify({
        certVerified: 'SUCCESS',
        certSubjectDN: 'CN=client.example.com',
        certIssuerDN: method === 'tls_client_auth' ? 'CN=Test CA' : '',
        certFingerprintSHA256: 'abcd',
      })
      const result = await runAuth(
        env,
        { 'x-mock-tls-client-auth': tlsHeader },
        'client_id=client_abc',
      )
      expect(result.ok).toBe(true)
    },
  )
})

describe('client-auth: 停用的 client', () => {
  it('status=revoked 被拒', async () => {
    const hash = await sha256Hex('secret')
    const row = makeAppRow({ client_secret_hash: hash, status: 'revoked' })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const creds = btoa('client_abc:secret')
    const result = await runAuth(env, { authorization: `Basic ${creds}` }, 'client_id=client_abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('inactive')
  })
})

describe('client-auth: private_key_jwt jti 防重放', () => {
  async function buildAssertion(): Promise<{ assertion: string; jwk: Record<string, unknown> }> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const jwk = (await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')) as unknown as Record<
      string,
      unknown
    >
    const now = Math.floor(Date.now() / 1000)
    const assertion = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: 'client_abc',
          sub: 'client_abc',
          aud: 'https://test.idx.dev/token',
          jti: 'jti-oauth-1',
          exp: now + 120,
          iat: now,
        },
      },
      pair.privateKey,
    )
    return { assertion, jwk }
  }

  it('首次验签成功,相同 jti 二次提交被拒', async () => {
    const { assertion, jwk } = await buildAssertion()
    const row = makeAppRow({
      token_endpoint_auth_method: 'private_key_jwt',
      client_secret_hash: null,
    })
    ;(row as Record<string, unknown>).jwks = JSON.stringify({ keys: [jwk] })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const body = `client_id=client_abc&client_assertion_type=${encodeURIComponent(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    )}&client_assertion=${assertion}`
    const first = await runAuth(env, {}, body)
    expect(first.ok).toBe(true)
    const second = await runAuth(env, {}, body)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.message).toContain('replay')
  })

  it('缺 jti 的 assertion 被拒', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const jwk = (await exportPublicJwk(pair.publicKey, 'ckid', 'ES256')) as unknown as Record<
      string,
      unknown
    >
    const now = Math.floor(Date.now() / 1000)
    const assertion = await signJwt(
      {
        header: { alg: 'ES256', kid: 'ckid' },
        payload: {
          iss: 'client_abc',
          sub: 'client_abc',
          aud: 'https://test.idx.dev/token',
          exp: now + 120,
          iat: now,
        },
      },
      pair.privateKey,
    )
    const row = makeAppRow({
      token_endpoint_auth_method: 'private_key_jwt',
      client_secret_hash: null,
    })
    ;(row as Record<string, unknown>).jwks = JSON.stringify({ keys: [jwk] })
    const db = makeFakeD1({ apps: [row] })
    const env = makeEnv(db)
    const body = `client_id=client_abc&client_assertion_type=${encodeURIComponent(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    )}&client_assertion=${assertion}`
    const result = await runAuth(env, {}, body)
    expect(result.ok).toBe(false)
  })
})
