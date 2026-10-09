// auth-policy 的会话与令牌覆盖:读取 PATCH 中的覆盖值,合并 token_policy JSON。

import type { schema } from '@xid-kit/db'
import { SESSION_POLICY_BOUNDS, TOKEN_POLICY_BOUNDS } from '@xid-kit/types'
import { AppError } from '../lib/errors'
import { hasOwn, isRecord } from './org-policy-fields'

// token_policy JSON 兼容 snake/camel 两键(见 types normalize 同模式);非法值按未覆盖处理。
export function storedPolicyNumber(
  record: Record<string, unknown> | null | undefined,
  camelKey: string,
  snakeKey: string,
): number | null {
  const value = record?.[camelKey] ?? record?.[snakeKey]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// 覆盖值语义:字段缺失 -> undefined(不动);显式 null -> null(清除覆盖,回退 instance 默认);
// 数字须落在 BOUNDS 内,越界/非数字 -> 422(paramName 精确到字段)。
function readPolicyOverrideField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  bounds: { min: number; max: number },
  paramName: string,
): number | null | undefined {
  const key = keys.find((candidate) => hasOwn(raw, candidate))
  if (key === undefined) return undefined
  const value = raw[key]
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  return value
}

export type TokenPolicyPatch = {
  accessTokenTtlSec: number | null | undefined
  sessionTokenTtlSec: number | null | undefined
  refreshIdleTimeoutDays: number | null | undefined
  refreshAbsoluteTimeoutDays: number | null | undefined
}

export function readTokenPolicyPatch(raw: unknown): TokenPolicyPatch | null {
  if (raw === undefined) return null
  if (!isRecord(raw)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'tokenPolicy' } })
  }
  const patch: TokenPolicyPatch = {
    accessTokenTtlSec: readPolicyOverrideField(
      raw,
      ['accessTokenTtlSec', 'access_token_ttl_sec'],
      TOKEN_POLICY_BOUNDS.accessTokenTtlSec,
      'tokenPolicy.accessTokenTtlSec',
    ),
    sessionTokenTtlSec: readPolicyOverrideField(
      raw,
      ['sessionTokenTtlSec', 'session_token_ttl_sec'],
      TOKEN_POLICY_BOUNDS.sessionTokenTtlSec,
      'tokenPolicy.sessionTokenTtlSec',
    ),
    refreshIdleTimeoutDays: readPolicyOverrideField(
      raw,
      ['refreshIdleTimeoutDays', 'refresh_idle_timeout_days'],
      TOKEN_POLICY_BOUNDS.refreshIdleTimeoutDays,
      'tokenPolicy.refreshIdleTimeoutDays',
    ),
    refreshAbsoluteTimeoutDays: readPolicyOverrideField(
      raw,
      ['refreshAbsoluteTimeoutDays', 'refresh_absolute_timeout_days'],
      TOKEN_POLICY_BOUNDS.refreshAbsoluteTimeoutDays,
      'tokenPolicy.refreshAbsoluteTimeoutDays',
    ),
  }
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'tokenPolicy' } })
  }
  return patch
}

// token_policy JSON 逐键合并:undefined 保留已有键,null 删键(回退 instance),数字覆盖;snake_case 落库。
function applyTokenJsonField(
  target: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  value: number | null | undefined,
): void {
  if (value === undefined) return
  delete target[camelKey]
  if (value === null) {
    delete target[snakeKey]
    return
  }
  target[snakeKey] = value
}

export function mergeTokenPolicy(
  existing: Record<string, unknown> | null | undefined,
  tokenPatch: TokenPolicyPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}
  applyTokenJsonField(
    next,
    'accessTokenTtlSec',
    'access_token_ttl_sec',
    tokenPatch.accessTokenTtlSec,
  )
  applyTokenJsonField(
    next,
    'sessionTokenTtlSec',
    'session_token_ttl_sec',
    tokenPatch.sessionTokenTtlSec,
  )
  applyTokenJsonField(
    next,
    'refreshIdleTimeoutDays',
    'refresh_idle_timeout_days',
    tokenPatch.refreshIdleTimeoutDays,
  )
  applyTokenJsonField(
    next,
    'refreshAbsoluteTimeoutDays',
    'refresh_absolute_timeout_days',
    tokenPatch.refreshAbsoluteTimeoutDays,
  )
  return next
}

export function readSessionPolicyPatch(
  rawSession: unknown,
): Partial<typeof schema.orgPolicies.$inferInsert> {
  if (rawSession === undefined) return {}
  if (!isRecord(rawSession)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sessionPolicy' },
    })
  }
  const idleTimeoutMin = readPolicyOverrideField(
    rawSession,
    ['idleTimeoutMin', 'idle_timeout_min'],
    SESSION_POLICY_BOUNDS.idleTimeoutMin,
    'sessionPolicy.idleTimeoutMin',
  )
  const absoluteTimeoutDays = readPolicyOverrideField(
    rawSession,
    ['absoluteTimeoutDays', 'absolute_timeout_days'],
    SESSION_POLICY_BOUNDS.absoluteTimeoutDays,
    'sessionPolicy.absoluteTimeoutDays',
  )
  if (idleTimeoutMin === undefined && absoluteTimeoutDays === undefined) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'sessionPolicy' },
    })
  }
  const updates: Partial<typeof schema.orgPolicies.$inferInsert> = {}
  if (idleTimeoutMin !== undefined) updates.sessionIdleTimeoutMin = idleTimeoutMin
  if (absoluteTimeoutDays !== undefined) updates.sessionAbsoluteTimeoutDays = absoluteTimeoutDays
  return updates
}
