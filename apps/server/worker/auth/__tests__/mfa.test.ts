// MFA 测试:TOTP 生成/验证/防重放/时钟容忍;step-up token 签发/验证;信封加密/解密。
// Web Crypto 用 Node 全局真实实现;D1/KV 用最小 fake。

import { describe, it, expect } from 'vitest'
import { toBufferSource } from '@xid-kit/crypto'
import {
  encryptTotpSecret,
  decryptTotpSecret,
  createTotpFactor,
  activateTotp,
  verifyTotp,
  issueStepUpToken,
  verifyStepUpToken,
} from '../mfa'
import type { TenantContext } from '@xid-kit/types'

// ---- 测试桩 ----

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.example.test',
  rpId: 'acme.example.test',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

// KEK: 32 字节 base64url
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

const KEK_RAW = base64UrlEncode(new Uint8Array(32).fill(0xcc))
const PEPPER_RAW = base64UrlEncode(new Uint8Array(32).fill(0xdd))

function asUnknown<T>(v: unknown): T {
  return v as T
}

// 最小 D1 fake
type AnyRow = Record<string, unknown>

function makeFakeD1(table: AnyRow[], capture?: { inserted: unknown[][] }): D1Database {
  const matchRows = (sql: string, params: unknown[]): AnyRow[] => {
    const lower = sql.toLowerCase()
    if (lower.startsWith('insert')) {
      capture?.inserted.push(params)
      return table.slice(-1)
    }
    if (lower.startsWith('update')) {
      for (const r of table) r['status'] = 'active'
      return []
    }
    if (lower.startsWith('delete')) {
      table.splice(0)
      return []
    }
    const stringParams = params.filter((v): v is string => typeof v === 'string')
    return table.filter((r) => stringParams.every((v) => Object.values(r).includes(v)))
  }
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => matchRows(sql, bound).map((r) => Object.values(r)),
      all: async () => ({ results: matchRows(sql, bound), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

// 最小 KV fake
function makeFakeKv(): KVNamespace {
  const store = new Map<string, string>()
  return asUnknown<KVNamespace>({
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v)
    },
    delete: async (k: string) => {
      store.delete(k)
    },
  })
}

// 生成合法 TOTP 行(供 verifyTotp 读取)
async function makeTotpRow(
  factorId: string,
  secretBytes: Uint8Array,
  kekRaw: string,
  status: 'active' | 'pending' = 'active',
): Promise<AnyRow> {
  const ciphertext = await encryptTotpSecret(secretBytes, kekRaw)
  return {
    id: factorId,
    tenant_id: 't_1',
    user_id: 'u_1',
    factor_type: 'totp',
    status,
    secret_ciphertext: ciphertext,
    target: null,
    passkey_credential_id: null,
    is_default: 0,
    last_used_at: null,
    activated_at: Date.now(),
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

async function totpCode(secretBytes: Uint8Array, nowSec: number): Promise<string> {
  const counter = BigInt(Math.floor(nowSec / 30))
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn)
    c >>= 8n
  }
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(secretBytes),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, msg))
  const offset = (sig[19] ?? 0) & 0x0f
  const code =
    (((sig[offset] ?? 0) & 0x7f) << 24) |
    (((sig[offset + 1] ?? 0) & 0xff) << 16) |
    (((sig[offset + 2] ?? 0) & 0xff) << 8) |
    ((sig[offset + 3] ?? 0) & 0xff)
  return String(code % 10 ** 6).padStart(6, '0')
}

// ---- 信封加密/解密 ----
describe('encryptTotpSecret + decryptTotpSecret', () => {
  it('加密后解密还原原始 secret', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(20))
    const ciphertext = await encryptTotpSecret(secret, KEK_RAW)
    expect(ciphertext.length).toBeGreaterThan(20)
    const decrypted = await decryptTotpSecret(ciphertext, KEK_RAW)
    expect(decrypted).toEqual(secret)
  })

  it('错误 KEK 解密失败(AES-GCM tag 不匹配)', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(20))
    const ciphertext = await encryptTotpSecret(secret, KEK_RAW)
    const wrongKek = base64UrlEncode(new Uint8Array(32).fill(0x00))
    await expect(decryptTotpSecret(ciphertext, wrongKek)).rejects.toThrow()
  })
})

// ---- createTotpFactor ----
describe('createTotpFactor', () => {
  it('写 DB 并返回 base32 secret', async () => {
    const table: AnyRow[] = []
    const capture = { inserted: [] as unknown[][] }
    const db = makeFakeD1(table, capture)
    // 预置 returning 行
    table.push({
      id: 'f_1',
      tenant_id: 't_1',
      user_id: 'u_1',
      factor_type: 'totp',
      status: 'pending',
      secret_ciphertext: new Uint8Array(50),
      target: null,
      passkey_credential_id: null,
      is_default: 0,
      last_used_at: null,
      activated_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    const result = await createTotpFactor({
      ctx: TENANT,
      d1: db,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'f_1',
    })
    expect(result.factorId).toBe('f_1')
    expect(typeof result.secretB32).toBe('string')
    expect(result.secretB32.length).toBeGreaterThan(0)
    // base32 字符集校验
    expect(result.secretB32).toMatch(/^[A-Z2-7]+$/)
  })
})

// ---- verifyTotp ----
describe('verifyTotp', () => {
  it('正确 code + 未重放 -> ok', async () => {
    // 生成已知 secret,手动算当前 TOTP
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const table: AnyRow[] = [row]
    const db = makeFakeD1(table)
    const cache = makeFakeKv()

    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    const result = await verifyTotp({
      ctx: TENANT,
      d1: db,
      cache,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'f_1',
      code,
      nowSec,
    })
    expect(result.ok).toBe(true)
  }, 15000)

  it('重放同一 code -> replayed', async () => {
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const cache = makeFakeKv()

    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    // 第一次
    const db2 = makeFakeD1([row])
    await verifyTotp({
      ctx: TENANT,
      d1: db2,
      cache,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'f_1',
      code,
      nowSec,
    })
    // 第二次
    const db3 = makeFakeD1([row])
    const res2 = await verifyTotp({
      ctx: TENANT,
      d1: db3,
      cache,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'f_1',
      code,
      nowSec,
    })
    expect(res2.ok).toBe(false)
    if (!res2.ok) expect(res2.reason).toBe('replayed')
  }, 15000)

  it('错误 code -> invalid_code', async () => {
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const db = makeFakeD1([row])
    const cache = makeFakeKv()
    const res = await verifyTotp({
      ctx: TENANT,
      d1: db,
      cache,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'f_1',
      code: '000000',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_code')
  }, 15000)

  it('factor 不存在 -> factor_not_found', async () => {
    const db = makeFakeD1([])
    const cache = makeFakeKv()
    const res = await verifyTotp({
      ctx: TENANT,
      d1: db,
      cache,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'no_such',
      code: '123456',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('factor_not_found')
  })
})

// ---- activateTotp ----
describe('activateTotp', () => {
  it('正确 code 可把 pending TOTP factor 激活', async () => {
    const secretBytes = new Uint8Array(20).fill(0x24)
    const row = await makeTotpRow('f_pending', secretBytes, KEK_RAW, 'pending')
    const table: AnyRow[] = [row]
    const db = makeFakeD1(table)
    const cache = makeFakeKv()
    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    const result = await activateTotp({
      ctx: TENANT,
      d1: db,
      cache,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'f_pending',
      code,
    })

    expect(result.ok).toBe(true)
    expect(row['status']).toBe('active')
  }, 15000)

  it('普通 TOTP 验证仍拒绝 pending factor', async () => {
    const secretBytes = new Uint8Array(20).fill(0x24)
    const row = await makeTotpRow('f_pending', secretBytes, KEK_RAW, 'pending')
    const db = makeFakeD1([row])
    const cache = makeFakeKv()
    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    const result = await verifyTotp({
      ctx: TENANT,
      d1: db,
      cache,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'f_pending',
      code,
      nowSec,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('factor_not_found')
  }, 15000)
})

// ---- issueStepUpToken + verifyStepUpToken ----
describe('issueStepUpToken + verifyStepUpToken', () => {
  it('签发 step-up token,验证 acr=step-up + sub + sid', async () => {
    const { token } = await issueStepUpToken({
      userId: 'u_1',
      sessionId: 's_1',
      method: 'totp',
      pepperRaw: PEPPER_RAW,
    })
    expect(token.split('.').length).toBe(3)
    const res = await verifyStepUpToken(token, PEPPER_RAW)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.payload.acr).toBe('step-up')
      expect(res.payload.sub).toBe('u_1')
      expect(res.payload.sid).toBe('s_1')
      expect(res.payload.method).toBe('totp')
      expect(res.payload.iat).toBeGreaterThan(0)
    }
  })

  it('错误 pepper 验证失败', async () => {
    const { token } = await issueStepUpToken({
      userId: 'u_1',
      sessionId: 's_1',
      method: 'totp',
      pepperRaw: PEPPER_RAW,
    })
    const wrong = base64UrlEncode(new Uint8Array(32).fill(0x00))
    const res = await verifyStepUpToken(token, wrong)
    expect(res.ok).toBe(false)
  })

  it('格式错误的 token 返回 invalid', async () => {
    const res = await verifyStepUpToken('bad.token', PEPPER_RAW)
    expect(res.ok).toBe(false)
  })

  it('篡改 payload 验证失败', async () => {
    const { token } = await issueStepUpToken({
      userId: 'u_1',
      sessionId: 's_1',
      method: 'totp',
      pepperRaw: PEPPER_RAW,
    })
    const parts = token.split('.')
    const evilBdy = btoa(
      JSON.stringify({
        sub: 'u_evil',
        acr: 'step-up',
        iat: 1_900_000_000,
        exp: 9_999_999_999,
        jti: 'x',
        sid: 's_1',
        method: 'totp',
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
    const tampered = `${parts[0]}.${evilBdy}.${parts[2]}`
    const res = await verifyStepUpToken(tampered, PEPPER_RAW)
    expect(res.ok).toBe(false)
  })
})
