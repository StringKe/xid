// passkey 注册/登录 handler 的纯辅助:challenge DO 读写、匿名 key 派生、凭证构建与持久化。
// 从 passkey.ts 抽出以控制文件行数;无路由逻辑,只被 passkey.ts 复用(见 webauthn rule 四验证编排)。

import { base64UrlDecode, base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { AuthenticatorTransport, CoseAlg, StoredCredential } from '@xid-kit/types'
import { verifyRegistration } from '@xid-kit/webauthn'
import { and, eq, isNull, lte } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { WEBAUTHN_CHALLENGE_TTL_MS } from '../lib/ttl'

// passkey 每账户上限(见 01 章 step 8)
export const PASSKEY_LIMIT = 10
// 别名保留:passkey.ts / me-auth/passkey-mfa-challenge.ts 及其测试 mock 按此名引用
export const CHALLENGE_TTL_MS = WEBAUTHN_CHALLENGE_TTL_MS

const VALID_TRANSPORTS = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']

function isPasskeyLimitError(error: unknown): boolean {
  return error instanceof Error && /passkey_limit_exceeded/iu.test(error.message)
}

// verifyRegistration 成功值类型(从 Result 收窄,避免重复内联条件类型)。
export type VerifiedRegistration = Extract<
  Awaited<ReturnType<typeof verifyRegistration>>,
  { ok: true }
>['value']

// ChallengeStore DO stub:id 由 anonymousSessionKey 派生(per 匿名 session,见 01 章)。
function challengeStub(env: Env, anonymousKey: string): DurableObjectStub {
  const ns = env.WEBAUTHN_CHALLENGE
  return ns.get(ns.idFromName(anonymousKey))
}

// 创建 challenge:生成 32 字节随机 base64url,存 DO。
export async function createChallenge(env: Env, anonymousKey: string): Promise<string> {
  const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const res = await challengeStub(env, anonymousKey).fetch('https://challenge-store/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: anonymousKey, value: challenge, ttlMs: CHALLENGE_TTL_MS }),
  })
  if (res.status !== 201) throw new AppError('internal_error')
  return challenge
}

// 消费 challenge:DO 内原子读取删除(一次性)。返回 null 仅表示 DO 明确答复"不存在/已过期"。
// fail closed:DO 故障或响应不可解析时不得降级为 null,否则调用方无法区分"challenge 已失效"
// 与"消费未真正发生",后者意味着 DO 里的 challenge 仍存活 -> 可重放,违反四验证无跳过路径。
export async function consumeChallenge(env: Env, anonymousKey: string): Promise<string | null> {
  const res = await challengeStub(env, anonymousKey).fetch('https://challenge-store/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: anonymousKey }),
  })
  // ChallengeStore 约定:200 { value } | 404 不存在 | 410 已过期,其余状态均为异常。
  if (res.status === 404 || res.status === 410) return null
  if (res.status !== 200) throw new AppError('server_error')

  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  if (!isChallengeConsumeBody(body)) throw new AppError('server_error')
  return body.value
}

// 非空字符串才算有效 challenge:未校验的 value 会被当作 expectedChallenge 送进验签,
// 空值/非字符串会让四验证的 challenge 比对失去意义。
function isChallengeConsumeBody(value: unknown): value is { value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string' &&
    value.value.length > 0
  )
}

// 匿名 session key cookie 名(passkey challenge 与 guest 模式共用)。
export const ANON_KEY_COOKIE = '__Host-xid.anon'

// 只读匿名 session key(不存在返回 null,不生成);guest 模式据此决定是否走 GuestStore 去重。
export function readAnonKey(c: Context<XidHonoEnv>): string | null {
  return (
    c.req
      .header('cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${ANON_KEY_COOKIE}=`))
      ?.split('=')[1] ?? null
  )
}

// 从 request 取匿名 session key(cookie 或 header),用于 challenge DO id 派生。
// 不存在时生成新 key 并通过 Set-Cookie 设置(httpOnly + SameSite=Strict)。
export function getOrCreateAnonKey(c: Context<XidHonoEnv>): string {
  const existing = readAnonKey(c)
  if (existing) return existing
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
}

// 从 DB 行构建 StoredCredential(认证时传给 verifyAuthentication)。blob 列在 D1 取回为 Buffer。
export function buildStoredCredential(cred: {
  credentialId: string
  publicKey: Uint8Array | ArrayBuffer
  coseAlg: number
  signCount: number
  aaguid: Uint8Array | ArrayBuffer
}): StoredCredential | undefined {
  if (cred.coseAlg !== -7 && cred.coseAlg !== -257 && cred.coseAlg !== -8) return undefined
  return {
    credentialId: base64UrlDecode(cred.credentialId),
    publicKey: new Uint8Array(cred.publicKey),
    coseAlg: cred.coseAlg as CoseAlg,
    signCount: cred.signCount,
    aaguid: new Uint8Array(cred.aaguid),
  }
}

// sign_count 克隆检测后续处理:写审计 + 更新 DB(01 章 step 7-8)。
export async function persistSignCount(opts: {
  env: Env
  tenantId: string
  cred: { userId: string; signCount: number; credentialId: string }
  newSignCount: number
  signCountAnomaly: boolean
  db: ReturnType<typeof createTenantDb>
}): Promise<void> {
  const { env, tenantId, cred, newSignCount, signCountAnomaly, db } = opts
  if (signCountAnomaly) {
    await env.AUDIT_QUEUE.send({
      tenantId,
      action: 'passkey.sign_count_anomaly',
      actorId: cred.userId,
      ts: Date.now(),
      payload: {
        credentialId: cred.credentialId,
        storedCount: cred.signCount,
        newCount: newSignCount,
      },
    })
  }
  const targetSignCount = Math.max(cred.signCount, newSignCount)
  const updated = await db.passkeyCredentials.update(
    { signCount: targetSignCount, lastUsedAt: new Date() },
    and(
      eq(schema.passkeyCredentials.credentialId, cred.credentialId),
      eq(schema.passkeyCredentials.userId, cred.userId),
      lte(schema.passkeyCredentials.signCount, targetSignCount),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
  )
  if (updated.length === 1) return

  const current = await db.passkeyCredentials.findOne(
    and(
      eq(schema.passkeyCredentials.credentialId, cred.credentialId),
      eq(schema.passkeyCredentials.userId, cred.userId),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
  )
  if (current && current.signCount >= targetSignCount) return
  throw new AppError('invalid_credentials')
}

// 注册成功后持久化新凭证:唯一性 + 上限校验 + 插入 PasskeyCredential(01 章 step 7-9)。
export async function persistNewCredential(opts: {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  userId: string
  credentialIdBase64: string
  verified: VerifiedRegistration
  transports: string[]
  deviceName: string | null
  sessionAmr?: readonly string[] | null
}): Promise<void> {
  const { db, tenantId, userId, credentialIdBase64, verified, transports, deviceName } = opts
  const existing = await db.passkeyCredentials.findOne(
    eq(schema.passkeyCredentials.credentialId, credentialIdBase64),
  )
  if (existing) throw new AppError('already_exists')

  const count = await db.passkeyCredentials.count(
    and(eq(schema.passkeyCredentials.userId, userId), isNull(schema.passkeyCredentials.revokedAt)),
  )
  if (count >= PASSKEY_LIMIT) throw new AppError('validation_failed')

  const validTransports = transports.filter((t): t is AuthenticatorTransport =>
    VALID_TRANSPORTS.includes(t),
  )
  try {
    await db.passkeyCredentials.insert({
      id: crypto.randomUUID(),
      tenantId,
      userId,
      credentialId: credentialIdBase64,
      publicKey: Buffer.from(verified.publicKey),
      coseAlg: verified.coseAlg,
      aaguid: Buffer.from(verified.aaguid),
      signCount: verified.signCount,
      transports: validTransports,
      credentialDeviceType: verified.credentialDeviceType,
      backedUp: verified.credentialBackedUp,
      deviceName,
      attestationFmt: verified.attestationFmt ?? 'none',
      enterpriseAttestationVerified: verified.enterpriseAttestationVerified ?? false,
      lastUsedAt: new Date(),
    })
  } catch (error) {
    if (isPasskeyLimitError(error)) throw new AppError('validation_failed')
    throw error
  }

  if (sessionAmrIncludesPhr(opts.sessionAmr)) {
    await db.mfaFactors.insert({
      id: `mf_${crypto.randomUUID()}`,
      tenantId,
      userId,
      factorType: 'passkey',
      status: 'active',
      passkeyCredentialId: credentialIdBase64,
      activatedAt: new Date(),
    })
  }
}

function sessionAmrIncludesPhr(sessionAmr?: readonly string[] | null): boolean {
  return Boolean(sessionAmr?.includes('phr'))
}
