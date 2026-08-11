// Refresh 轮换与 family 重放检测:纯判定与材料组装,不碰 I/O;明文只出一次,入库仅 token_hash。

import type { AmrValue, AuthorizationDetails, XidError, Result } from '@xid-kit/types'
import { base64UrlEncode } from '@xid-kit/crypto'

const encoder = new TextEncoder()
const REFRESH_TOKEN_PREFIX = 'rt_'
const REFRESH_RANDOM_BYTES = 32 // 256 bit
const DEFAULT_IDLE_TTL_SEC = 30 * 24 * 60 * 60 // 30d
const DEFAULT_ABSOLUTE_TTL_SEC = 7 * 24 * 60 * 60 // 7d

export type RefreshTokenRecord = {
  id: string
  tenantId: string
  tokenHash: string
  familyId: string
  parentTokenId: string | null
  userId: string
  sessionId: string | null
  clientId: string
  scope: string
  jkt: string | null
  activeOrgId: string | null
  projectGrantId: string | null
  resource: readonly string[] | null
  authorizationDetails: readonly AuthorizationDetails[] | null
  authTime: number | null
  acr: string | null
  amr: readonly AmrValue[] | null
  revokedAt: number | null
  expiresAt: number
  absoluteExpiresAt: number
  createdAt: number
}

// 明文只返回一次供响应体,绝不持久化。
export type IssuedRefreshToken = {
  token: string
  tokenHash: string
  record: RefreshTokenRecord
}

export function generateRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(REFRESH_RANDOM_BYTES))
  return `${REFRESH_TOKEN_PREFIX}${base64UrlEncode(bytes)}`
}

export async function hashRefreshToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))
  return base64UrlEncode(digest)
}

function invalidGrant(message: string): Result<never, XidError> {
  return { ok: false, error: { code: 'invalid_grant', message, httpStatus: 400 } }
}

function invalidScope(message: string): Result<never, XidError> {
  return { ok: false, error: { code: 'invalid_scope', message, httpStatus: 400 } }
}

// replay 命中时携带 revokeFamily 指令,endpoint 层据此撤销整个 family。
export type RefreshDecision =
  | { kind: 'replay'; familyId: string; tenantId: string }
  | { kind: 'expired'; tokenId: string }
  | { kind: 'client_mismatch' }
  | { kind: 'dpop_mismatch' }
  | { kind: 'ok'; record: RefreshTokenRecord }

// 已轮换(revokedAt != null)再次出现 = 重放,须撤销 family。
export function detectReplay(input: {
  record: RefreshTokenRecord
  clientId: string
  now: number
  presentedJkt: string | null
}): RefreshDecision {
  const rec = input.record
  if (rec.revokedAt !== null) {
    return { kind: 'replay', familyId: rec.familyId, tenantId: rec.tenantId }
  }
  if (input.now > rec.expiresAt || input.now > rec.absoluteExpiresAt) {
    return { kind: 'expired', tokenId: rec.id }
  }
  if (rec.clientId !== input.clientId) {
    return { kind: 'client_mismatch' }
  }
  // DPoP sender-constrained:原 token 已绑 jkt 时,本次 proof jkt 必须相等。
  if (rec.jkt !== null && rec.jkt !== input.presentedJkt) {
    return { kind: 'dpop_mismatch' }
  }
  return { kind: 'ok', record: rec }
}

export function decisionToResult(decision: RefreshDecision): Result<RefreshTokenRecord, XidError> {
  switch (decision.kind) {
    case 'ok':
      return { ok: true, value: decision.record }
    case 'replay':
      return invalidGrant('refresh token replay detected; family revoked')
    case 'expired':
      return invalidGrant('refresh token expired (idle or absolute timeout)')
    case 'client_mismatch':
      return invalidGrant('refresh token not bound to this client')
    case 'dpop_mismatch':
      return invalidGrant('refresh token DPoP binding mismatch')
  }
}

// 请求 scope 必须 ⊆ 原 token scope,只能缩小不能扩大(RFC6749 6)。
export function narrowScope(
  originalScope: string,
  requestedScope: string | null,
): Result<string, XidError> {
  if (requestedScope === null || requestedScope === '') {
    return { ok: true, value: originalScope }
  }
  const allowed = new Set(originalScope.split(' ').filter(Boolean))
  const requested = requestedScope.split(' ').filter(Boolean)
  for (const s of requested) {
    if (!allowed.has(s)) return invalidScope(`scope "${s}" exceeds original grant`)
  }
  return { ok: true, value: requested.join(' ') }
}

export async function issueRefreshFamily(input: {
  tenantId: string
  userId: string
  clientId: string
  scope: string
  jkt: string | null
  sessionId?: string | null
  activeOrgId?: string | null
  projectGrantId?: string | null
  resource?: readonly string[] | null
  authorizationDetails?: readonly AuthorizationDetails[] | null
  authTime?: number | null
  acr?: string | null
  amr?: readonly AmrValue[] | null
  now: number
  idleTtlSec?: number
  absoluteTtlSec?: number
  newId: string
  familyId: string
}): Promise<IssuedRefreshToken> {
  const token = generateRefreshToken()
  const tokenHash = await hashRefreshToken(token)
  const idleTtl = input.idleTtlSec ?? DEFAULT_IDLE_TTL_SEC
  const absoluteTtl = input.absoluteTtlSec ?? DEFAULT_ABSOLUTE_TTL_SEC
  const record: RefreshTokenRecord = {
    id: input.newId,
    tenantId: input.tenantId,
    tokenHash,
    familyId: input.familyId,
    parentTokenId: null,
    userId: input.userId,
    clientId: input.clientId,
    scope: input.scope,
    jkt: input.jkt,
    sessionId: input.sessionId ?? null,
    activeOrgId: input.activeOrgId ?? null,
    projectGrantId: input.projectGrantId ?? null,
    resource: input.resource ?? null,
    authorizationDetails: input.authorizationDetails ?? null,
    authTime: input.authTime ?? null,
    acr: input.acr ?? null,
    amr: input.amr ?? null,
    revokedAt: null,
    expiresAt: input.now + idleTtl,
    absoluteExpiresAt: input.now + absoluteTtl,
    createdAt: input.now,
  }
  return { token, tokenHash, record }
}

// 轮换:idle 刷新,absoluteExpiresAt 继承不顺延。
export async function rotateRefresh(input: {
  old: RefreshTokenRecord
  scope: string
  now: number
  idleTtlSec?: number
  newId: string
}): Promise<{ issued: IssuedRefreshToken; revokedOld: RefreshTokenRecord }> {
  const token = generateRefreshToken()
  const tokenHash = await hashRefreshToken(token)
  const idleTtl = input.idleTtlSec ?? DEFAULT_IDLE_TTL_SEC
  const record: RefreshTokenRecord = {
    id: input.newId,
    tenantId: input.old.tenantId,
    tokenHash,
    familyId: input.old.familyId,
    parentTokenId: input.old.id,
    userId: input.old.userId,
    clientId: input.old.clientId,
    scope: input.scope,
    jkt: input.old.jkt,
    sessionId: input.old.sessionId,
    activeOrgId: input.old.activeOrgId,
    projectGrantId: input.old.projectGrantId,
    resource: input.old.resource,
    authorizationDetails: input.old.authorizationDetails,
    authTime: input.old.authTime,
    acr: input.old.acr,
    amr: input.old.amr,
    revokedAt: null,
    expiresAt: input.now + idleTtl,
    absoluteExpiresAt: input.old.absoluteExpiresAt, // 继承,不顺延
    createdAt: input.now,
  }
  const revokedOld: RefreshTokenRecord = { ...input.old, revokedAt: input.now }
  return { issued: { token, tokenHash, record }, revokedOld }
}

export { DEFAULT_IDLE_TTL_SEC, DEFAULT_ABSOLUTE_TTL_SEC, REFRESH_TOKEN_PREFIX }
