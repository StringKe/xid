// Backup / recovery codes(对照 docs/design/01-authentication.md 第 5 节、password-auth rule)。
// 10 个 8 字符一次性恢复码;HMAC-SHA256 哈希存储;展示一次;重生成作废旧批次。
// 密码学原语只用 Web Crypto(见 crypto-boundary rule)。

import { base64UrlDecode, base64UrlEncode, hmacSha256Base64, randomString } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'

// ---- 参数 ----
const CODE_COUNT = 10
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混淆字符 O/0/I/1
const CODE_LENGTH = 8

// pepper 解码:格式 "v<N>:<base64url>" 或裸 base64url(与 password.ts 一致,pepper 不入 DB)。
function decodePepper(raw: string): Uint8Array {
  const match = raw.match(/^v\d+:(.+)$/)
  return base64UrlDecode(match ? (match[1] ?? '') : raw)
}

// 恢复码哈希 = HMAC-SHA256(key=PEPPER, message=normalized code),设计要求(password-auth rule)。
function hashCode(code: string, pepperRaw: string): Promise<string> {
  return hmacSha256Base64(decodePepper(pepperRaw), code.toUpperCase().trim())
}

// ---- 生成恢复码 ----

function generateCode(): string {
  return randomString(CODE_LENGTH, CODE_CHARSET)
}

export type GeneratedBackupCodes = {
  batchId: string
  codes: string[] // 明文,展示一次后不再保留
}

// 生成 CODE_COUNT 个恢复码,持久化哈希(HMAC-SHA256),返回明文供一次展示。
// 重生成时先作废旧批次(删除旧 batch 行)。
export async function generateBackupCodes(opts: {
  ctx: TenantContext
  d1: D1Database
  userId: string
  baseIdPrefix: string // 调用方提供的 ID 前缀(如 "bc_"),后缀用随机字节
  pepper: string // env.PEPPER:HMAC-SHA256 key 来源(不入 DB)
}): Promise<GeneratedBackupCodes> {
  const { ctx, d1, userId, baseIdPrefix, pepper } = opts
  const batchId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  const codes: string[] = []

  const db = createTenantDb(d1, ctx)

  await db.backupCodes.hardDelete(eq(schema.backupCodes.userId, userId) as ReturnType<typeof eq>)

  const rows = await Promise.all(
    Array.from({ length: CODE_COUNT }, async (_, i) => {
      const code = generateCode()
      codes.push(code)
      const codeHash = await hashCode(code, pepper)
      const id = `${baseIdPrefix}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(8)))}_${i}`
      return {
        id,
        tenantId: ctx.tenantId,
        userId,
        batchId,
        codeHash,
        used: false,
        usedAt: null,
        createdAt: new Date(),
      }
    }),
  )

  await db.backupCodes.insertMany(rows as Parameters<typeof db.backupCodes.insertMany>[0])

  return { batchId, codes }
}

// ---- 验证并消耗恢复码 ----

export type VerifyBackupCodeResult =
  | { ok: true; codeId: string }
  | { ok: false; reason: 'not_found' | 'already_used' }

export async function verifyAndConsumeBackupCode(opts: {
  ctx: TenantContext
  d1: D1Database
  userId: string
  code: string
  pepper: string // env.PEPPER:HMAC-SHA256 key 来源(不入 DB)
}): Promise<VerifyBackupCodeResult> {
  const { ctx, d1, userId, code, pepper } = opts
  const codeHash = await hashCode(code, pepper)
  const db = createTenantDb(d1, ctx)

  const row = await db.backupCodes.findOne(
    and(
      eq(schema.backupCodes.userId, userId),
      eq(schema.backupCodes.codeHash, codeHash),
    ) as ReturnType<typeof and>,
  )

  if (!row) return { ok: false, reason: 'not_found' }
  if (row.used) return { ok: false, reason: 'already_used' }

  const consumed = await db.backupCodes.update(
    { used: true, usedAt: new Date() },
    and(
      eq(schema.backupCodes.id, row.id),
      eq(schema.backupCodes.userId, userId),
      eq(schema.backupCodes.used, false),
    ) as ReturnType<typeof and>,
  )
  if (consumed.length === 0) return { ok: false, reason: 'already_used' }

  return { ok: true, codeId: row.id }
}

// ---- 查询剩余可用数量 ----

export async function countRemainingBackupCodes(opts: {
  ctx: TenantContext
  d1: D1Database
  userId: string
}): Promise<number> {
  const { ctx, d1, userId } = opts
  const db = createTenantDb(d1, ctx)
  return db.backupCodes.count(
    and(eq(schema.backupCodes.userId, userId), eq(schema.backupCodes.used, false)) as ReturnType<
      typeof and
    >,
  )
}
