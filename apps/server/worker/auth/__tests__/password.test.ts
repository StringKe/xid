// 密码认证测试:hashPassword/verifyPassword/checkHibpBreached/
// isPasswordReused/createResetToken/verifyResetToken。
// Web Crypto 用 Node 全局真实实现;HIBP fetch 用 fake;D1 用最小 fake。

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  validatePasswordLength,
  hashPassword,
  verifyPassword,
  checkHibpBreached,
  createResetToken,
  isPasswordReused,
  passwordReuseTag,
  verifyResetToken,
} from '../password'
import { makeFakeD1, TENANT } from '../../me/__tests__/harness'

// pepper: 32 字节随机,base64url 编码(版本 1 格式)
const PEPPER_BYTES = new Uint8Array(32).fill(0xab) // 固定测试 pepper

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

const PEPPER = base64UrlEncode(PEPPER_BYTES)

// ---- validatePasswordLength ----
describe('validatePasswordLength', () => {
  it('短于 12 -> too_short', () => {
    const res = validatePasswordLength('short')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.reason).toBe('too_short')
  })

  it('长于 128 -> too_long', () => {
    const res = validatePasswordLength('a'.repeat(129))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.reason).toBe('too_long')
  })

  it('12-128 字符 -> ok', () => {
    expect(validatePasswordLength('ValidPass123').ok).toBe(true)
    expect(validatePasswordLength('a'.repeat(128)).ok).toBe(true)
  })
})

// ---- hashPassword + verifyPassword ----
describe('hashPassword + verifyPassword', () => {
  it('哈希后可验证正确密码', async () => {
    const password = 'CorrectPassword123!'
    const { hash, algo } = await hashPassword(password, PEPPER)
    expect(algo).toBe('argon2id')
    expect(hash).toContain('$argon2id$')
    const valid = await verifyPassword(password, hash, algo, PEPPER)
    expect(valid).toBe(true)
  }, 30000)

  it('错误密码验证失败', async () => {
    const { hash, algo } = await hashPassword('CorrectPassword123!', PEPPER)
    const valid = await verifyPassword('WrongPassword123!', hash, algo, PEPPER)
    expect(valid).toBe(false)
  }, 30000)

  it('不同 pepper 验证失败', async () => {
    const otherPepper = base64UrlEncode(new Uint8Array(32).fill(0x11))
    const { hash, algo } = await hashPassword('CorrectPassword123!', PEPPER)
    const valid = await verifyPassword('CorrectPassword123!', hash, algo, otherPepper)
    expect(valid).toBe(false)
  }, 30000)

  it('损坏的 hash 返回 false 不抛(dummy 消耗)', async () => {
    const valid = await verifyPassword('SomePassword1234', 'not-a-valid-hash', 'argon2id', PEPPER)
    expect(valid).toBe(false)
  }, 30000)
})

// ---- checkHibpBreached ----
describe('checkHibpBreached', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('HIBP 返回命中 suffix -> breached=true', async () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    // prefix=5BAA6, suffix=1E4C9B93F3F0682250B6CF8331B7EE68FD8
    const mockText = '1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345\n'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => mockText }))
    const result = await checkHibpBreached('password')
    expect(result).toBe(true)
  })

  it('HIBP 未命中 -> breached=false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'AAAAA:1\n' }))
    const result = await checkHibpBreached('password')
    expect(result).toBe(false)
  })

  it('HIBP 网络失败 fail-open -> breached=false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await checkHibpBreached('password')
    expect(result).toBe(false)
  })
})

// ---- isPasswordReused ----
describe('isPasswordReused', () => {
  function passwordRow(reuseTag: string): Record<string, unknown> {
    return {
      id: 'pw_1',
      tenant_id: TENANT.tenantId,
      user_id: 'u_1',
      hash: '$argon2id$v=19$m=65536,t=3,p=1$old$old',
      algo: 'argon2id',
      pepper_version: 1,
      reuse_tag: reuseTag,
      breached: 0,
      breach_checked_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
  }

  function historyRow(reuseTag: string, createdAt: number): Record<string, unknown> {
    return {
      id: crypto.randomUUID(),
      tenant_id: TENANT.tenantId,
      user_id: 'u_1',
      hash: '$argon2id$v=19$m=65536,t=3,p=1$old$old',
      reuse_tag: reuseTag,
      created_at: createdAt,
    }
  }

  it('rejects reusing the current password via reuse tag without Argon2 history scan', async () => {
    const password = 'CurrentReuse123!'
    const reuseTag = await passwordReuseTag(password, PEPPER)
    const db = makeFakeD1({ passwords: [passwordRow(reuseTag)], password_history: [] })

    const result = await isPasswordReused({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      newPassword: password,
      pepperRaw: PEPPER,
    })

    expect(result).toBe(true)
  })

  it('rejects reusing a recent password history tag', async () => {
    const password = 'HistoryReuse123!'
    const reuseTag = await passwordReuseTag(password, PEPPER)
    const db = makeFakeD1({
      passwords: [passwordRow(await passwordReuseTag('DifferentCurrent123!', PEPPER))],
      password_history: [historyRow(reuseTag, Date.now())],
    })

    const result = await isPasswordReused({
      ctx: TENANT,
      d1: db,
      userId: 'u_1',
      newPassword: password,
      pepperRaw: PEPPER,
    })

    expect(result).toBe(true)
  })
})

// ---- createResetToken + verifyResetToken ----
describe('createResetToken + verifyResetToken', () => {
  async function makeResetSigner() {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])
    return {
      signer: { kid: 'kid-reset', alg: 'ES256' as const, privateKey: keyPair.privateKey },
      verifyKeys: {
        keys: [{ kid: 'kid-reset', alg: 'ES256' as const, publicKey: keyPair.publicKey }],
      },
    }
  }

  it('创建 token 可验证,userId/jti 正确', async () => {
    const { signer, verifyKeys } = await makeResetSigner()
    const { token, tokenHash, expiresAt, jti } = await createResetToken('u_1', signer, {
      issuer: 'https://xid.dev',
      tenantId: 'tenant-1',
    })
    expect(typeof token).toBe('string')
    expect(token.split('.').length).toBe(3)
    expect(typeof tokenHash).toBe('string')
    expect(tokenHash.length).toBe(64) // SHA-256 hex
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now())

    const res = await verifyResetToken(token, verifyKeys, {
      expectedIssuer: 'https://xid.dev',
      expectedTenantId: 'tenant-1',
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.userId).toBe('u_1')
      expect(res.jti).toBe(jti)
    }
  })

  it('错误 issuer 验证失败', async () => {
    const { signer, verifyKeys } = await makeResetSigner()
    const { token } = await createResetToken('u_1', signer, {
      issuer: 'https://xid.dev',
      tenantId: 'tenant-1',
    })
    const res = await verifyResetToken(token, verifyKeys, {
      expectedIssuer: 'https://other-issuer.example.com',
      expectedTenantId: 'tenant-1',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid')
  })

  it('错误 tenant_id 验证失败', async () => {
    const { signer, verifyKeys } = await makeResetSigner()
    const { token } = await createResetToken('u_1', signer, {
      issuer: 'https://xid.dev',
      tenantId: 'tenant-1',
    })
    const res = await verifyResetToken(token, verifyKeys, {
      expectedIssuer: 'https://xid.dev',
      expectedTenantId: 'tenant-2',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid')
  })

  it('篡改 payload 验证失败', async () => {
    const { signer, verifyKeys } = await makeResetSigner()
    const { token } = await createResetToken('u_1', signer, {
      issuer: 'https://xid.dev',
      tenantId: 'tenant-1',
    })
    const parts = token.split('.')
    // 修改 payload(第二段)
    const tamperedPayload = btoa(
      '{"sub":"u_evil","jti":"x","exp":9999999999,"purpose":"password_reset","tenant_id":"tenant-1"}',
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`
    const res = await verifyResetToken(tampered, verifyKeys, {
      expectedIssuer: 'https://xid.dev',
      expectedTenantId: 'tenant-1',
    })
    expect(res.ok).toBe(false)
  })

  it('已过期 token 返回 expired', async () => {
    const { verifyKeys } = await makeResetSigner()
    const res = await verifyResetToken('bad.format', verifyKeys, {
      expectedIssuer: 'https://xid.dev',
      expectedTenantId: 'tenant-1',
    })
    expect(res.ok).toBe(false)
  })

  it('格式错误的 token 返回 invalid', async () => {
    const { verifyKeys } = await makeResetSigner()
    const res = await verifyResetToken('not-a-token', verifyKeys, {
      expectedIssuer: 'https://xid.dev',
      expectedTenantId: 'tenant-1',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid')
  })
})
