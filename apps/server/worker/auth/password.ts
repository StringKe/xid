// 密码认证核心(对照 docs/design/01-authentication.md 第 2 节、password-auth rule)。
// Argon2id(memory=64MiB/iter=3);pepper 从 env.PEPPER(Workers Secrets);
// HIBP k-anonymity;密码历史最近 5 条;超长截断(12-128);
// 重置 token = TenantContext active signing key 签发的 JWT,只存 SHA-256 哈希。
// 枚举防护:无论用户是否存在,所有校验路径等时消耗。

import { argon2id } from '@noble/hashes/argon2'
import {
  base64UrlDecode,
  base64UrlEncode,
  hmacSha256Base64,
  sha256Hex,
  signJwt,
  verifyJwt,
} from '@xid-kit/crypto'
import type { JwtClaims, VerifyKeySet } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { Result, SigningAlg, TenantContext } from '@xid-kit/types'
import { and, desc, eq } from 'drizzle-orm'
import { PASSWORD_RESET_TTL_MS } from '../lib/ttl'

// --- 参数常量 ---
const ARGON2_MEMORY_KB = 65536 // 64 MiB(password-auth rule)
const ARGON2_ITERATIONS = 3
const ARGON2_HASH_LEN = 32
const ARGON2_PARALLELISM = 1
const MIN_LENGTH = 12
const MAX_LENGTH = 128
const HISTORY_COUNT = 5
const PASSWORD_REUSE_TAG_PREFIX = 'pwd-reuse:v1:'

// ---- 内部辅助 ----

// constant-time 字符串比对(防时序侧信道)。
function timingSafeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function normalizePasswordForReuse(password: string): string {
  return truncate(password)
}

// pepper 解码:格式 "v<N>:<base64url>" 或裸 base64url(版本 1)。
function decodePepper(raw: string): Uint8Array {
  const match = raw.match(/^v\d+:(.+)$/)
  return base64UrlDecode(match ? (match[1] ?? '') : raw)
}

function currentPepperVersion(raw: string): number {
  const match = raw.match(/^v(\d+):/)
  return match ? parseInt(match[1] ?? '1', 10) : 1
}

// pepper concat:concat(pepper, utf8(password)) -> Argon2id 输入(pepper 是服务端 secret,不入 DB)。
function applyPepper(password: string, pepper: Uint8Array): Uint8Array {
  const pw = new TextEncoder().encode(password)
  const out = new Uint8Array(pepper.length + pw.length)
  out.set(pepper, 0)
  out.set(pw, pepper.length)
  return out
}

// 超长截断(防 bcrypt DoS,见 password-auth rule)。
function truncate(password: string): string {
  return password.length > MAX_LENGTH ? password.slice(0, MAX_LENGTH) : password
}

// 解析 "m=..,t=..,p=.." 段为数字键值对(忽略缺 = 或非数字项)。
function parseArgon2Params(paramStr: string): Record<string, number> {
  const params: Record<string, number> = {}
  for (const seg of paramStr.split(',')) {
    const idx = seg.indexOf('=')
    if (idx < 0) continue
    const k = seg.slice(0, idx)
    const v = parseInt(seg.slice(idx + 1), 10)
    if (k && !isNaN(v)) params[k] = v
  }
  return params
}

function argon2idDigest(
  password: Uint8Array,
  salt: Uint8Array,
  opts: { m: number; t: number; p: number },
) {
  return argon2id(password, salt, {
    m: opts.m,
    t: opts.t,
    p: opts.p,
    dkLen: ARGON2_HASH_LEN,
    version: 0x13,
  })
}

function encodeArgon2Hash(
  digest: Uint8Array,
  salt: Uint8Array,
  opts: { m: number; t: number; p: number },
) {
  return `$argon2id$v=19$m=${opts.m},t=${opts.t},p=${opts.p}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`
}

// argon2id encoded hash 解析:提取 salt 与参数(用于 verify)。
// 格式: $argon2id$v=19$m=M,t=T,p=P$SALT$HASH
function parseArgon2Encoded(
  encoded: string,
): { salt: Uint8Array; digest: Uint8Array; m: number; t: number; p: number } | undefined {
  const parts = encoded.split('$')
  // parts[0]='', [1]='argon2id', [2]='v=19', [3]='m=..,t=..,p=..', [4]=saltB64, [5]=hashB64
  if (parts.length < 6) return undefined
  if (parts[1] !== 'argon2id' || parts[2] !== 'v=19') return undefined
  const saltB64 = parts[4]
  const hashB64 = parts[5]
  if (!saltB64 || !hashB64) return undefined
  const params = parseArgon2Params(parts[3] ?? '')
  try {
    return {
      salt: base64UrlDecode(saltB64),
      digest: base64UrlDecode(hashB64),
      m: params['m'] ?? ARGON2_MEMORY_KB,
      t: params['t'] ?? ARGON2_ITERATIONS,
      p: params['p'] ?? ARGON2_PARALLELISM,
    }
  } catch {
    return undefined
  }
}

// ---- 密码长度校验 ----

export type LengthError = { reason: 'too_short' | 'too_long' }

export function validatePasswordLength(password: string): Result<true, LengthError> {
  if (password.length < MIN_LENGTH) return { ok: false, error: { reason: 'too_short' } }
  if (password.length > MAX_LENGTH) return { ok: false, error: { reason: 'too_long' } }
  return { ok: true, value: true }
}

// ---- Argon2id 哈希 ----

export type PasswordHashMeta = {
  hash: string
  algo: 'argon2id'
  pepperVersion: number
}

export async function hashPassword(password: string, pepperRaw: string): Promise<PasswordHashMeta> {
  const pw = truncate(password)
  const pepper = decodePepper(pepperRaw)
  const combined = applyPepper(pw, pepper)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const opts = {
    m: ARGON2_MEMORY_KB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
  }
  const digest = argon2idDigest(combined, salt, opts)
  return {
    hash: encodeArgon2Hash(digest, salt, opts),
    algo: 'argon2id',
    pepperVersion: currentPepperVersion(pepperRaw),
  }
}

export function currentPasswordPepperVersion(pepperRaw: string): number {
  return currentPepperVersion(pepperRaw)
}

export async function passwordReuseTag(password: string, pepperRaw: string): Promise<string> {
  return `${PASSWORD_REUSE_TAG_PREFIX}${await hmacSha256Base64(
    decodePepper(pepperRaw),
    normalizePasswordForReuse(password),
  )}`
}

async function consumeDummyHash(): Promise<void> {
  argon2idDigest(new Uint8Array(1), crypto.getRandomValues(new Uint8Array(16)), {
    m: ARGON2_MEMORY_KB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
  })
}

// ---- 密码校验(constant-time,枚举防护) ----
// algo='argon2id':从 encoded 解析 salt 重算比对。
// 无论分支都执行等量计算防时序。

export async function verifyPassword(
  password: string,
  storedHash: string,
  algo: string,
  pepperRaw: string,
): Promise<boolean> {
  const pw = truncate(password)
  if (algo !== 'argon2id') {
    await consumeDummyHash()
    return false
  }
  // argon2id
  const parsed = parseArgon2Encoded(storedHash)
  if (!parsed) {
    // dummy 消耗防时序
    await consumeDummyHash()
    return false
  }
  const pepper = decodePepper(pepperRaw)
  const combined = applyPepper(pw, pepper)
  const recomputed = argon2idDigest(combined, parsed.salt, parsed)
  if (recomputed.length !== parsed.digest.length) return false
  return timingSafeStrEqual(base64UrlEncode(recomputed), base64UrlEncode(parsed.digest))
}

// ---- HIBP k-anonymity breach 检测(SHA-1 前 5 位,见 password-auth rule) ----
// 注册/改密强制;登录异步不阻断(调用方决定阻断策略)。
// 返回 true 表示密码已泄露。网络失败 fail-open(返回 false)。

export async function checkHibpBreached(password: string): Promise<boolean> {
  const sha1 = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password))
  const hex = Array.from(new Uint8Array(sha1))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
  const prefix = hex.slice(0, 5)
  const suffix = hex.slice(5)
  try {
    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
    })
    if (!resp.ok) return false
    const text = await resp.text()
    return text.split('\n').some((line) => {
      const col = line.indexOf(':')
      return col >= 0 && line.slice(0, col).trim().toUpperCase() === suffix
    })
  } catch {
    return false
  }
}

// ---- 密码历史检查(最近 HISTORY_COUNT 条) ----
// 返回 true 表示与历史密码重复(拒绝重用,见 password-auth rule)。

export async function isPasswordReused(opts: {
  ctx: TenantContext
  d1: D1Database
  userId: string
  newPassword: string
  pepperRaw: string
}): Promise<boolean> {
  const { ctx, d1, userId, newPassword, pepperRaw } = opts
  const db = createTenantDb(d1, ctx)
  const candidateTag = await passwordReuseTag(newPassword, pepperRaw)
  const current = await db.passwords.findOne(eq(schema.passwords.userId, userId))
  if (current?.reuseTag && timingSafeStrEqual(candidateTag, current.reuseTag)) return true

  const rows = await db.passwordHistory.findMany(
    and(eq(schema.passwordHistory.userId, userId)) as ReturnType<typeof eq>,
    { orderBy: desc(schema.passwordHistory.createdAt), limit: HISTORY_COUNT },
  )
  for (const row of rows) {
    if (row.reuseTag && timingSafeStrEqual(candidateTag, row.reuseTag)) return true
  }
  return false
}

// ---- 密码重置 token ----
// token = ES256/RS256/PS256 JWT(与 instance issuer/JWKS 对齐);DB 只存 SHA-256(token)。

export type ResetTokenPayload = {
  sub: string
  jti: string
  exp: number
  iss: string
  purpose: 'password_reset'
  tenant_id: string
}

export type CreateResetTokenResult = {
  token: string
  tokenHash: string
  expiresAt: Date
  jti: string
}

export type ResetTokenSigner = {
  kid: string
  alg: SigningAlg
  privateKey: CryptoKey
}

export async function createResetToken(
  userId: string,
  signer: ResetTokenSigner,
  opts: { issuer: string; tenantId: string },
): Promise<CreateResetTokenResult> {
  const jti = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  const iat = Math.floor(Date.now() / 1000)
  const exp = Math.floor(Date.now() / 1000) + PASSWORD_RESET_TTL_MS / 1000
  const payload: JwtClaims & ResetTokenPayload = {
    iss: opts.issuer,
    sub: userId,
    jti,
    iat,
    exp,
    purpose: 'password_reset',
    tenant_id: opts.tenantId,
  }
  const token = await signJwt(
    { header: { alg: signer.alg, kid: signer.kid }, payload },
    signer.privateKey,
  )
  const tokenHash = await sha256Hex(token)
  return { token, tokenHash, expiresAt: new Date(exp * 1000), jti }
}

export type VerifyResetTokenResult =
  | { ok: true; userId: string; jti: string }
  | { ok: false; reason: 'invalid' | 'expired' }

export async function verifyResetToken(
  token: string,
  verifyKeys: VerifyKeySet,
  opts: { expectedIssuer: string; expectedTenantId: string },
): Promise<VerifyResetTokenResult> {
  const verified = await verifyJwt(token, verifyKeys, { expectedIssuer: opts.expectedIssuer })
  if (!verified.ok) {
    return { ok: false, reason: verified.error.reason === 'expired' ? 'expired' : 'invalid' }
  }
  const { sub, jti, purpose, tenant_id } = verified.value.payload
  if (
    !sub ||
    !jti ||
    purpose !== 'password_reset' ||
    typeof tenant_id !== 'string' ||
    tenant_id !== opts.expectedTenantId
  ) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, userId: sub, jti }
}
