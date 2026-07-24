// MFA 核心:TOTP(RFC 6238,30s,+-1 步容忍)+ step-up token(acr:step-up,5min)。
// TOTP secret AES-256-GCM 加密(信封加密,KEK 从 env.KEK);
// 防重放:已用 code 存 KV TTL=60s(见 password-auth rule)。
// 密码学原语只用 Web Crypto(crypto.subtle),不自研原语(见 crypto-boundary rule)。
// step-up token 独立颁发,不复用登录 session token(见 01 章 5 设计决策)。

import {
  base64UrlDecode,
  base64UrlEncode,
  envelopeDecrypt,
  envelopeEncrypt,
  toBufferSource,
} from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { Result, TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import { TOTP_REPLAY_KV_TTL_SEC, TOTP_STEP_SEC } from '../lib/ttl'

// ---- TOTP 参数(RFC 6238) ----
const TOTP_DIGITS = 6
const TOTP_CLOCK_DRIFT_STEPS = 1 // 容忍正负 1 步

// step-up token 生命周期(5min,见 01 章 5)
const STEP_UP_TTL_SEC = 5 * 60

// KEK 版本(信封加密,见 signing-keys rule:KEK 存 Workers Secrets)
const KEK_VERSION = 1

// ---- HOTP(RFC 4226)核心:HMAC-SHA1 -> truncate -> 6 位 OTP ----
// TOTP = HOTP(key, floor(now / step))。
// 密码学原语只用 crypto.subtle.sign HMAC-SHA-1。

async function hotp(keyBytes: Uint8Array, counter: bigint): Promise<string> {
  // counter -> 8 字节 big-endian
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn)
    c >>= 8n
  }
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, msg))
  // Dynamic truncation(RFC 4226 Section 5.3)
  const offset = sig[19] !== undefined ? sig[19] & 0x0f : 0
  const code =
    (((sig[offset] ?? 0) & 0x7f) << 24) |
    (((sig[offset + 1] ?? 0) & 0xff) << 16) |
    (((sig[offset + 2] ?? 0) & 0xff) << 8) |
    ((sig[offset + 3] ?? 0) & 0xff)
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

// counter = floor(unix_time_sec / step)
function totpCounter(timeSec: number): bigint {
  return BigInt(Math.floor(timeSec / TOTP_STEP_SEC))
}

// ---- TOTP secret 信封加密/解密(AES-256-GCM,见 crypto-boundary / signing-keys rule) ----
// KEK 从 env.KEK(base64url 编码 32 字节,Workers Secrets)。

function decodeKek(kekRaw: string): Uint8Array {
  return base64UrlDecode(kekRaw)
}

export async function encryptTotpSecret(
  secretBytes: Uint8Array,
  kekRaw: string,
): Promise<Uint8Array> {
  const kek = decodeKek(kekRaw)
  const blob = await envelopeEncrypt(secretBytes, kek, KEK_VERSION)
  // 序列化为: version(1B) || ivLen(1B) || iv || ciphertextLen(2B) || ciphertext || tag(16B)
  const iv = blob.iv
  const ct = blob.ciphertext
  const tag = blob.tag
  const buf = new Uint8Array(1 + 1 + iv.length + 2 + ct.length + tag.length)
  let off = 0
  buf[off++] = blob.kekVersion & 0xff
  buf[off++] = iv.length & 0xff
  buf.set(iv, off)
  off += iv.length
  buf[off++] = (ct.length >> 8) & 0xff
  buf[off++] = ct.length & 0xff
  buf.set(ct, off)
  off += ct.length
  buf.set(tag, off)
  return buf
}

export async function decryptTotpSecret(
  ciphertext: Uint8Array,
  kekRaw: string,
): Promise<Uint8Array> {
  let off = 0
  const kekVersion = ciphertext[off++] ?? 0
  const ivLen = ciphertext[off++] ?? 12
  const iv = ciphertext.slice(off, off + ivLen)
  off += ivLen
  const ctLen = ((ciphertext[off] ?? 0) << 8) | (ciphertext[off + 1] ?? 0)
  off += 2
  const ct = ciphertext.slice(off, off + ctLen)
  off += ctLen
  const tag = ciphertext.slice(off)
  const kek = decodeKek(kekRaw)
  return envelopeDecrypt({ iv, ciphertext: ct, tag, kekVersion }, kek)
}

// ---- KV replay cache key ----
function replayKey(tenantId: string, userId: string, factorId: string, code: string): string {
  return `totp:replay:${tenantId}:${userId}:${factorId}:${code}`
}

// 时钟容忍:遍历 [now-drift, now+drift] 步长,检查是否有匹配 code。
async function totpCodeMatches(
  secretBytes: Uint8Array,
  code: string,
  nowSec: number,
): Promise<boolean> {
  for (let drift = -TOTP_CLOCK_DRIFT_STEPS; drift <= TOTP_CLOCK_DRIFT_STEPS; drift++) {
    const counter = totpCounter(nowSec + drift * TOTP_STEP_SEC)
    const expected = await hotp(secretBytes, counter)
    if (expected === code) return true
  }
  return false
}

// TOTP secret ciphertext 转 Uint8Array(兼容 Buffer/Uint8Array)。
function toUint8Array(src: Uint8Array | Buffer): Uint8Array {
  return src instanceof Uint8Array ? src : new Uint8Array(src)
}

// ---- TOTP 验证(防重放 + 时钟容忍) ----
// 返回 ok 或失败原因。

export type TotpVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_code' | 'replayed' | 'factor_not_found' | 'decrypt_failed' }

async function verifyTotpWithStatus(opts: {
  ctx: TenantContext
  d1: D1Database
  cache: KVNamespace
  kekRaw: string
  userId: string
  factorId: string
  code: string
  expectedStatus: 'active' | 'pending'
  nowSec?: number
}): Promise<TotpVerifyResult> {
  const { ctx, d1, cache, kekRaw, userId, factorId, code, expectedStatus, nowSec } = opts
  const now = nowSec ?? Math.floor(Date.now() / 1000)

  const db = createTenantDb(d1, ctx)
  const factor = await db.mfaFactors.findOne(
    and(eq(schema.mfaFactors.userId, userId), eq(schema.mfaFactors.id, factorId)) as ReturnType<
      typeof and
    >,
  )
  if (!factor || factor.status !== expectedStatus) return { ok: false, reason: 'factor_not_found' }
  if (!factor.secretCiphertext) return { ok: false, reason: 'decrypt_failed' }

  let secretBytes: Uint8Array
  try {
    secretBytes = await decryptTotpSecret(toUint8Array(factor.secretCiphertext), kekRaw)
  } catch {
    return { ok: false, reason: 'decrypt_failed' }
  }

  // 防重放检查(KV)
  const rk = replayKey(ctx.tenantId, userId, factorId, code)
  if ((await cache.get(rk)) !== null) return { ok: false, reason: 'replayed' }

  if (!(await totpCodeMatches(secretBytes, code, now))) return { ok: false, reason: 'invalid_code' }

  // 写入 replay cache(TTL 60s,覆盖有效验证窗口)
  await cache.put(rk, '1', { expirationTtl: TOTP_REPLAY_KV_TTL_SEC })
  return { ok: true }
}

export async function verifyTotp(opts: {
  ctx: TenantContext
  d1: D1Database
  cache: KVNamespace
  kekRaw: string
  userId: string
  factorId: string
  code: string
  nowSec?: number
}): Promise<TotpVerifyResult> {
  return verifyTotpWithStatus({ ...opts, expectedStatus: 'active' })
}

// ---- TOTP factor 创建(secret 生成 + 加密 + 写 DB) ----
// 状态 pending,绑定时确认一次有效 code 后 activate。

export type CreateTotpResult = {
  factorId: string
  secretB32: string // 展示给用户扫 QR 用(base32 编码)
}

// base32 encode(大写,无 padding,RFC 4648)用于 QR code/otpauth URI。
function base32Encode(bytes: Uint8Array): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CHARS[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += CHARS[(value << (5 - bits)) & 31]
  return out
}

export async function createTotpFactor(opts: {
  ctx: TenantContext
  d1: D1Database
  kekRaw: string
  userId: string
  factorId: string
}): Promise<CreateTotpResult> {
  const { ctx, d1, kekRaw, userId, factorId } = opts
  // 生成 20 字节(160 bit)TOTP secret(RFC 6238 推荐)
  const secretBytes = crypto.getRandomValues(new Uint8Array(20))
  const secretB32 = base32Encode(secretBytes)
  const ciphertext = await encryptTotpSecret(secretBytes, kekRaw)

  const db = createTenantDb(d1, ctx)
  await db.mfaFactors.insert({
    id: factorId,
    tenantId: ctx.tenantId,
    userId,
    factorType: 'totp',
    status: 'pending',
    secretCiphertext: ciphertext as unknown as Buffer,
  })

  return { factorId, secretB32 }
}

// ---- TOTP factor 激活(首次验证确认后 pending -> active) ----

export type ActivateTotpResult = Result<
  true,
  { reason: 'invalid_code' | 'already_active' | 'factor_not_found' | 'decrypt_failed' }
>

export async function activateTotp(opts: {
  ctx: TenantContext
  d1: D1Database
  cache: KVNamespace
  kekRaw: string
  userId: string
  factorId: string
  code: string
}): Promise<ActivateTotpResult> {
  const { ctx, d1, cache, kekRaw, userId, factorId, code } = opts
  const db = createTenantDb(d1, ctx)
  const factor = await db.mfaFactors.findOne(
    and(eq(schema.mfaFactors.userId, userId), eq(schema.mfaFactors.id, factorId)) as ReturnType<
      typeof and
    >,
  )
  if (!factor) return { ok: false, error: { reason: 'factor_not_found' } }
  if (factor.status === 'active') return { ok: false, error: { reason: 'already_active' } }
  if (factor.status !== 'pending') return { ok: false, error: { reason: 'factor_not_found' } }

  const verifyResult = await verifyTotpWithStatus({
    ctx,
    d1,
    cache,
    kekRaw,
    userId,
    factorId,
    code,
    expectedStatus: 'pending',
  })
  if (!verifyResult.ok) {
    if (verifyResult.reason === 'factor_not_found' || verifyResult.reason === 'decrypt_failed') {
      return { ok: false, error: { reason: verifyResult.reason } }
    }
    return { ok: false, error: { reason: 'invalid_code' } }
  }

  await db.mfaFactors.update(
    { status: 'active', activatedAt: new Date() },
    and(eq(schema.mfaFactors.id, factorId)) as ReturnType<typeof eq>,
  )
  return { ok: true, value: true }
}

// ---- Step-up token(acr:step-up,5min,独立颁发) ----
// 不复用登录 session token(见 01 章 5 设计决策)。
// step-up token 是 HMAC-SHA256 mini-JWT;API 网关校验 acr 字段。
// key 派生自 env.PEPPER(server secret)。

export type StepUpPasskeyAssurance = {
  userVerified: boolean
  credentialBackedUp: boolean
  credentialDeviceType: 'singleDevice' | 'multiDevice'
  enterpriseAttestationVerified: boolean
}

export type StepUpPayload = {
  sub: string // userId
  acr: 'step-up'
  iat: number
  exp: number
  jti: string
  sid: string // sessionId,绑定到当前会话
  method: 'totp' | 'backup' | 'sms' | 'passkey'
  passkeyAssurance?: StepUpPasskeyAssurance
}

export type IssueStepUpResult = {
  token: string
}

export async function issueStepUpToken(opts: {
  userId: string
  sessionId: string
  method: 'totp' | 'backup' | 'sms' | 'passkey'
  pepperRaw: string
  passkeyAssurance?: StepUpPasskeyAssurance
}): Promise<IssueStepUpResult> {
  const { userId, sessionId, method, pepperRaw, passkeyAssurance } = opts
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + STEP_UP_TTL_SEC
  const payload: StepUpPayload = {
    sub: userId,
    acr: 'step-up',
    iat,
    exp,
    jti,
    sid: sessionId,
    method,
    ...(passkeyAssurance ? { passkeyAssurance } : {}),
  }
  const hdr = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ typ: 'sut', alg: 'HS256' })),
  )
  const bdy = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = `${hdr}.${bdy}`

  const pepper = base64UrlDecode(pepperRaw.replace(/^v\d+:/, ''))
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(signingInput)),
  )
  return { token: `${signingInput}.${base64UrlEncode(sig)}` }
}

export type VerifyStepUpResult =
  | { ok: true; payload: StepUpPayload }
  | { ok: false; reason: 'invalid' | 'expired' }

export async function verifyStepUpToken(
  token: string,
  pepperRaw: string,
): Promise<VerifyStepUpResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'invalid' }
  const [hdr, bdy, sigB64] = parts as [string, string, string]

  let payload: StepUpPayload
  try {
    const raw = bdy.replace(/-/g, '+').replace(/_/g, '/')
    const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), '=')
    payload = JSON.parse(atob(padded)) as StepUpPayload
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  if (payload.acr !== 'step-up') return { ok: false, reason: 'invalid' }
  if (!Number.isFinite(payload.iat)) return { ok: false, reason: 'invalid' }
  if (
    payload.method !== 'totp' &&
    payload.method !== 'backup' &&
    payload.method !== 'sms' &&
    payload.method !== 'passkey'
  ) {
    return { ok: false, reason: 'invalid' }
  }
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp < now) return { ok: false, reason: 'expired' }

  const pepper = base64UrlDecode(pepperRaw.replace(/^v\d+:/, ''))
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signingInput = `${hdr}.${bdy}`
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(signingInput)),
  )
  const expectedB64 = base64UrlEncode(expected)
  // constant-time compare
  if (sigB64.length !== expectedB64.length) return { ok: false, reason: 'invalid' }
  let diff = 0
  for (let i = 0; i < sigB64.length; i++) {
    diff |= sigB64.charCodeAt(i) ^ expectedB64.charCodeAt(i)
  }
  if (diff !== 0) return { ok: false, reason: 'invalid' }

  return { ok: true, payload }
}
