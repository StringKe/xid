// MFA 测试:TOTP 生成/验证/强一致防重放/时钟容忍;step-up token 签发/验证;信封加密/解密。
// Web Crypto 用 Node 全局真实实现;D1 用最小 fake;防重放使用真实 ChallengeStore 逻辑。

import { describe, it, expect, vi } from 'vitest'
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
import { ChallengeStore } from '../../durable-objects/challenge-store'
import { MockDurableObjectState } from '../../durable-objects/__tests__/mock-do-state'

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

// 每个 id 对应一个真实 ChallengeStore 实例,stub 把同一 DO 的事件串行化。
function makeReplayStore(): DurableObjectNamespace {
  type Entry = { instance: ChallengeStore; tail: Promise<void> }
  const objects = new Map<string, Entry>()
  return asUnknown<DurableObjectNamespace>({
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        let entry = objects.get(id)
        if (!entry) {
          const state = new MockDurableObjectState()
          const instance = new ChallengeStore(asUnknown<DurableObjectState>(state))
          state.setAlarmHandler(() => instance.alarm())
          entry = { instance, tail: Promise.resolve() }
          objects.set(id, entry)
        }
        const request = new Request(input, init)
        const response = entry.tail.then(() => entry.instance.fetch(request))
        entry.tail = response.then(
          () => undefined,
          () => undefined,
        )
        return response
      },
    }),
  })
}

function makeFailingReplayStore(): DurableObjectNamespace {
  return asUnknown<DurableObjectNamespace>({
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response('unavailable', { status: 500 }),
    }),
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
  it('对每个 drift 位置和无效 code 都执行固定三个 HMAC window', async () => {
    const secretBytes = new Uint8Array(20).fill(0x42)
    const nowSec = 1_700_000_010
    const validCodes = await Promise.all(
      [-1, 0, 1].map((drift) => totpCode(secretBytes, nowSec + drift * 30)),
    )
    expect(new Set(validCodes).size).toBe(3)
    let invalidCode = '000000'
    while (validCodes.includes(invalidCode)) {
      invalidCode = String(Number(invalidCode) + 1).padStart(6, '0')
    }

    for (const [code, expectedOk] of [
      ...validCodes.map((value) => [value, true] as const),
      [invalidCode, false] as const,
    ]) {
      const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
      const signSpy = vi.spyOn(crypto.subtle, 'sign')
      try {
        const result = await verifyTotp({
          ctx: TENANT,
          d1: makeFakeD1([row]),
          replayStore: makeReplayStore(),
          kekRaw: KEK_RAW,
          userId: 'u_1',
          factorId: 'f_1',
          code,
          nowSec,
        })
        expect(result.ok).toBe(expectedOk)
        expect(signSpy).toHaveBeenCalledTimes(3)
      } finally {
        signSpy.mockRestore()
      }
    }
  }, 15000)

  it('正确 code + 未重放 -> ok', async () => {
    // 生成已知 secret,手动算当前 TOTP
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const table: AnyRow[] = [row]
    const db = makeFakeD1(table)
    const replayStore = makeReplayStore()

    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    const result = await verifyTotp({
      ctx: TENANT,
      d1: db,
      replayStore,
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
    const replayStore = makeReplayStore()

    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)
    const signSpy = vi.spyOn(crypto.subtle, 'sign')

    try {
      // 第一次
      const db2 = makeFakeD1([row])
      await verifyTotp({
        ctx: TENANT,
        d1: db2,
        replayStore,
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
        replayStore,
        kekRaw: KEK_RAW,
        userId: 'u_1',
        factorId: 'f_1',
        code,
        nowSec,
      })
      expect(res2.ok).toBe(false)
      if (!res2.ok) expect(res2.reason).toBe('replayed')
      expect(signSpy).toHaveBeenCalledTimes(6)
    } finally {
      signSpy.mockRestore()
    }
  }, 15000)

  it('未来窗口 code 首次使用 61 秒后仍被识别为 replay', async () => {
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const replayStore = makeReplayStore()
    const stepStartSec = Math.floor(1_700_000_000 / 30) * 30
    const firstNowSec = stepStartSec + 1
    const code = await totpCode(secretBytes, stepStartSec + 30)
    const dateNowSpy = vi.spyOn(Date, 'now')

    try {
      dateNowSpy.mockReturnValue(firstNowSec * 1_000)
      const first = await verifyTotp({
        ctx: TENANT,
        d1: makeFakeD1([row]),
        replayStore,
        kekRaw: KEK_RAW,
        userId: 'u_1',
        factorId: 'f_1',
        code,
        nowSec: firstNowSec,
      })
      expect(first.ok).toBe(true)

      const replayNowSec = firstNowSec + 61
      dateNowSpy.mockReturnValue(replayNowSec * 1_000)
      const replay = await verifyTotp({
        ctx: TENANT,
        d1: makeFakeD1([row]),
        replayStore,
        kekRaw: KEK_RAW,
        userId: 'u_1',
        factorId: 'f_1',
        code,
        nowSec: replayNowSec,
      })
      expect(replay.ok).toBe(false)
      if (!replay.ok) expect(replay.reason).toBe('replayed')
    } finally {
      dateNowSpy.mockRestore()
    }
  }, 15000)

  it('并发验证同一 code 只有一个 claim 成功', async () => {
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const replayStore = makeReplayStore()
    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    const verify = () =>
      verifyTotp({
        ctx: TENANT,
        d1: makeFakeD1([row]),
        replayStore,
        kekRaw: KEK_RAW,
        userId: 'u_1',
        factorId: 'f_1',
        code,
        nowSec,
      })
    const results = await Promise.all([verify(), verify()])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.reason === 'replayed')).toHaveLength(1)
  }, 15000)

  it('错误 code -> invalid_code', async () => {
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const db = makeFakeD1([row])
    const replayStore = makeReplayStore()
    const res = await verifyTotp({
      ctx: TENANT,
      d1: db,
      replayStore,
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
    const replayStore = makeReplayStore()
    const res = await verifyTotp({
      ctx: TENANT,
      d1: db,
      replayStore,
      kekRaw: KEK_RAW,
      userId: 'u_1',
      factorId: 'no_such',
      code: '123456',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('factor_not_found')
  })

  it('有效 code 在 replay store 不可用时 fail closed', async () => {
    const secretBytes = new Uint8Array(20).fill(0x42)
    const row = await makeTotpRow('f_1', secretBytes, KEK_RAW)
    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    await expect(
      verifyTotp({
        ctx: TENANT,
        d1: makeFakeD1([row]),
        replayStore: makeFailingReplayStore(),
        kekRaw: KEK_RAW,
        userId: 'u_1',
        factorId: 'f_1',
        code,
        nowSec,
      }),
    ).rejects.toMatchObject({ code: 'server_error' })
  }, 15000)
})

// ---- activateTotp ----
describe('activateTotp', () => {
  it('正确 code 可把 pending TOTP factor 激活', async () => {
    const secretBytes = new Uint8Array(20).fill(0x24)
    const row = await makeTotpRow('f_pending', secretBytes, KEK_RAW, 'pending')
    const table: AnyRow[] = [row]
    const db = makeFakeD1(table)
    const replayStore = makeReplayStore()
    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    const result = await activateTotp({
      ctx: TENANT,
      d1: db,
      replayStore,
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
    const replayStore = makeReplayStore()
    const nowSec = Math.floor(Date.now() / 1000)
    const code = await totpCode(secretBytes, nowSec)

    const result = await verifyTotp({
      ctx: TENANT,
      d1: db,
      replayStore,
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
