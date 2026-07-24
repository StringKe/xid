// lib/validate 校验层测试:readJsonBody 坏 JSON 契约、validateBody/validateQuery 的
// 成功与失败路径(含嵌套 dot path、缺字段、数字转换)、原子 schema 各一条。
// 用真实 Hono request 构造 Context,覆盖 c.req.json() 抛 SyntaxError 的分支。

import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../errors'
import type { XidHonoEnv } from '../types'
import {
  emailSchema,
  httpsUrlSchema,
  isPublicHttpsUrl,
  otpCodeSchema,
  paginationQuerySchema,
  publicHttpsUrlSchema,
  readJsonBody,
  slugSchema,
  ttlSecSchema,
  uuidSchema,
  validateBody,
  validateQuery,
  validateRedirectUris,
} from '../validate'

function catchAppError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected AppError to be thrown')
}

function buildEchoApp() {
  const app = new Hono<XidHonoEnv>()
  app.post('/', async (c) => {
    const result = await readJsonBody(c)
    if (!result.ok) return c.json({ ok: false })
    return c.json({ ok: true, value: result.value as null })
  })
  return app
}

describe('readJsonBody', () => {
  it('returns ok:false for malformed JSON instead of throwing', async () => {
    const app = buildEchoApp()

    const res = await app.request('https://acme.xid.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false })
  })

  it('returns ok:true with parsed value for valid JSON', async () => {
    const app = buildEchoApp()

    const res = await app.request('https://acme.xid.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })

    expect(await res.json()).toEqual({ ok: true, value: { a: 1 } })
  })
})

describe('validateBody', () => {
  const schema = v.object({ email: emailSchema })

  it('returns typed output on success', () => {
    const output = validateBody(schema, { email: 'a@b.com' })

    expect(output).toEqual({ email: 'a@b.com' })
  })

  it('throws 422 with paramName of the failing field', () => {
    const error = catchAppError(() => validateBody(schema, { email: 123 }))

    expect(error.code).toBe('validation_failed')
    expect(error.httpStatus).toBe(422)
    expect(error.meta?.paramName).toBe('email')
  })

  it('reports nested dot path for nested object failures', () => {
    const nested = v.object({ tokenPolicy: v.object({ accessTokenTtlSec: v.number() }) })

    const error = catchAppError(() => validateBody(nested, { tokenPolicy: {} }))

    expect(error.meta?.paramName).toBe('tokenPolicy.accessTokenTtlSec')
  })

  it('reports the missing field name when a required key is absent', () => {
    const error = catchAppError(() => validateBody(v.object({ name: v.string() }), {}))

    expect(error.meta?.paramName).toBe('name')
  })

  it('falls back to root when input is not an object at all', () => {
    const error = catchAppError(() => validateBody(v.object({ name: v.string() }), null))

    expect(error.meta?.paramName).toBe('root')
  })
})

describe('validateQuery', () => {
  it('transforms numeric strings to numbers', () => {
    const schema = v.object({
      limit: v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1)),
    })

    const output = validateQuery(schema, { limit: '10' })

    expect(output.limit).toBe(10)
  })

  it('parses paginationQuerySchema with limit + cursor', () => {
    const output = validateQuery(paginationQuerySchema, { limit: '50', cursor: 'u_1' })

    expect(output).toEqual({ limit: 50, cursor: 'u_1' })
  })

  it('rejects out-of-range limit with paramName limit', () => {
    const error = catchAppError(() => validateQuery(paginationQuerySchema, { limit: '0' }))

    expect(error.meta?.paramName).toBe('limit')
  })
})

describe('atomic schemas', () => {
  it('emailSchema rejects non-email strings', () => {
    expect(v.safeParse(emailSchema, 'not-an-email').success).toBe(false)
    expect(v.safeParse(emailSchema, 'a@b.com').success).toBe(true)
  })

  it('uuidSchema accepts uuid and rejects others', () => {
    expect(v.safeParse(uuidSchema, '3f6c9f6e-2a1b-4c5d-8e9f-0a1b2c3d4e5f').success).toBe(true)
    expect(v.safeParse(uuidSchema, 'u_123').success).toBe(false)
  })

  it('slugSchema rejects uppercase and leading hyphen', () => {
    expect(v.safeParse(slugSchema, 'acme-corp').success).toBe(true)
    expect(v.safeParse(slugSchema, 'Acme').success).toBe(false)
    expect(v.safeParse(slugSchema, '-acme').success).toBe(false)
  })

  it('httpsUrlSchema rejects http URLs', () => {
    expect(v.safeParse(httpsUrlSchema, 'https://auth.customer.com/cb').success).toBe(true)
    expect(v.safeParse(httpsUrlSchema, 'http://auth.customer.com/cb').success).toBe(false)
  })

  it('otpCodeSchema requires exactly 6 digits', () => {
    expect(v.safeParse(otpCodeSchema, '123456').success).toBe(true)
    expect(v.safeParse(otpCodeSchema, '12345').success).toBe(false)
  })

  it('ttlSecSchema enforces min/max bounds', () => {
    const schema = ttlSecSchema(60, 86400)

    expect(v.safeParse(schema, 3600).success).toBe(true)
    expect(v.safeParse(schema, 59).success).toBe(false)
    expect(v.safeParse(schema, 86401).success).toBe(false)
  })
})

describe('publicHttpsUrlSchema(SSRF 防护)', () => {
  it('放行公网 https 域名与公网 IP 字面量', () => {
    expect(v.safeParse(publicHttpsUrlSchema, 'https://hooks.example.com/x').success).toBe(true)
    expect(v.safeParse(publicHttpsUrlSchema, 'https://8.8.8.8/dns').success).toBe(true)
    expect(v.safeParse(publicHttpsUrlSchema, 'https://172.15.0.1/').success).toBe(true)
  })

  it('拒绝明文 http 与非法 URL', () => {
    expect(v.safeParse(publicHttpsUrlSchema, 'http://hooks.example.com').success).toBe(false)
    expect(v.safeParse(publicHttpsUrlSchema, 'not-a-url').success).toBe(false)
  })

  it('拒绝 IPv4 保留段:0/8、10/8、127/8、169.254/16、172.16/12、192.168/16', () => {
    const blocked = [
      'https://0.0.0.0/',
      'https://10.0.0.1/',
      'https://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://172.16.0.1/',
      'https://172.31.255.254/',
      'https://192.168.1.1/',
    ]
    for (const url of blocked) {
      expect(v.safeParse(publicHttpsUrlSchema, url).success).toBe(false)
    }
  })

  it('拒绝 hex/octal/短形式 IPv4 绕过(URL 归一后仍命中 127/8)', () => {
    for (const url of ['https://0x7f000001/', 'https://0177.0.0.1/', 'https://127.1/']) {
      expect(v.safeParse(publicHttpsUrlSchema, url).success).toBe(false)
    }
  })

  it('拒绝 IPv6 保留段:::1、::、fc00::/7、IPv4 映射', () => {
    const blocked = [
      'https://[::1]/',
      'https://[::]/',
      'https://[fc00::1]/',
      'https://[fd12:3456::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:10.0.0.1]/',
    ]
    for (const url of blocked) {
      expect(v.safeParse(publicHttpsUrlSchema, url).success).toBe(false)
    }
  })

  it('isPublicHttpsUrl 与 schema 行为一致', () => {
    expect(isPublicHttpsUrl('https://hooks.example.com')).toBe(true)
    expect(isPublicHttpsUrl('https://192.168.0.1')).toBe(false)
    expect(isPublicHttpsUrl('http://example.com')).toBe(false)
    expect(isPublicHttpsUrl('https://')).toBe(false)
  })
})

describe('validateRedirectUris', () => {
  const web = { applicationType: 'web', grantTypes: ['authorization_code'] } as const
  const native = { applicationType: 'native', grantTypes: ['authorization_code'] } as const

  it('web client 只接受 https 绝对 URL', () => {
    expect(validateRedirectUris(['https://app.example.com/cb'], web).ok).toBe(true)
    expect(validateRedirectUris(['http://app.example.com/cb'], web).ok).toBe(false)
    expect(validateRedirectUris(['not-a-url'], web).ok).toBe(false)
    expect(validateRedirectUris(['/relative/path'], web).ok).toBe(false)
  })

  it('拒绝 fragment 与空串', () => {
    expect(validateRedirectUris(['https://app.example.com/cb#frag'], web).ok).toBe(false)
    expect(validateRedirectUris([''], web).ok).toBe(false)
  })

  it('authorization_code grant 必须至少一个 redirect_uri', () => {
    expect(validateRedirectUris([], web).ok).toBe(false)
    const m2m = { applicationType: 'web', grantTypes: ['client_credentials'] } as const
    expect(validateRedirectUris([], m2m).ok).toBe(true)
  })

  it('native 放行 loopback http 与反域名自定义 scheme', () => {
    expect(validateRedirectUris(['http://127.0.0.1:3000/cb'], native).ok).toBe(true)
    expect(validateRedirectUris(['http://[::1]:3000/cb'], native).ok).toBe(true)
    expect(validateRedirectUris(['com.example.app:/cb'], native).ok).toBe(true)
  })

  it('native 拒绝非 loopback http 与单词 scheme', () => {
    expect(validateRedirectUris(['http://app.example.com/cb'], native).ok).toBe(false)
    expect(validateRedirectUris(['http://192.168.1.1/cb'], native).ok).toBe(false)
    expect(validateRedirectUris(['javascript:alert(1)'], native).ok).toBe(false)
  })

  it('web client 不放行 loopback http 与自定义 scheme', () => {
    expect(validateRedirectUris(['http://127.0.0.1:3000/cb'], web).ok).toBe(false)
    expect(validateRedirectUris(['com.example.app:/cb'], web).ok).toBe(false)
  })
})
