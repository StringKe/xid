// 组织策略类 PATCH 共用的字段读取:camel/snake 双键、缺失沿用旧值、字符串数组与私有 metadata。

import type { schema } from '@xid-kit/db'
import { AppError } from '../lib/errors'
import { isPublicHttpsUrl } from '../lib/validate'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalString(value: unknown): string | undefined {
  const parsed = stringOrEmpty(value)
  return parsed === '' ? undefined : parsed
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

export function readStringField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  existing: string | undefined,
): string {
  for (const key of keys) {
    if (hasOwn(raw, key)) return stringOrEmpty(raw[key])
  }
  return existing ?? ''
}

export function readOptionalStringField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  existing: string | undefined,
): string | undefined {
  for (const key of keys) {
    if (hasOwn(raw, key)) return optionalString(raw[key])
  }
  return existing
}

export function readStringArrayField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  existing: readonly string[] | undefined,
  normalize = false,
): readonly string[] {
  for (const key of keys) {
    if (hasOwn(raw, key)) {
      const parsed = stringArray(raw[key])
      return normalize ? parsed.map((item) => item.trim().toLowerCase()).filter(Boolean) : parsed
    }
  }
  return existing ?? []
}

export function readPrivateMetadata(
  org: typeof schema.organizations.$inferSelect,
): Record<string, unknown> {
  return isRecord(org.privateMetadata) ? org.privateMetadata : {}
}

export type LoginPolicyPatch = {
  forceSso?: boolean
  allowPasswordLogin?: boolean
}

function invalidLoginPolicy(paramName: string): AppError {
  return new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
}

function readBooleanField(
  raw: Record<string, unknown>,
  keys: readonly string[],
  paramName: string,
): boolean | undefined {
  const key = keys.find((candidate) => hasOwn(raw, candidate))
  if (key === undefined) return undefined
  const value = raw[key]
  if (typeof value !== 'boolean') throw invalidLoginPolicy(paramName)
  return value
}

// org_policies.force_sso / allow_password_login:字段缺失不动,非布尔 422。
export function readLoginPolicyPatch(raw: unknown): LoginPolicyPatch | null {
  if (raw === undefined) return null
  if (!isRecord(raw)) throw invalidLoginPolicy('loginPolicy')
  const forceSso = readBooleanField(raw, ['forceSso', 'force_sso'], 'loginPolicy.forceSso')
  const allowPasswordLogin = readBooleanField(
    raw,
    ['allowPasswordLogin', 'allow_password_login'],
    'loginPolicy.allowPasswordLogin',
  )
  if (forceSso === undefined && allowPasswordLogin === undefined) {
    throw invalidLoginPolicy('loginPolicy')
  }
  return {
    ...(forceSso === undefined ? {} : { forceSso }),
    ...(allowPasswordLogin === undefined ? {} : { allowPasswordLogin }),
  }
}

export function assertOptionalPublicHttpsUrl(
  value: string | null | undefined,
  paramName: string,
): void {
  if (value === null || value === undefined || isPublicHttpsUrl(value)) return
  throw new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName },
  })
}
