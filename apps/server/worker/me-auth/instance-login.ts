// 根域 Hosted Auth resolver:仅 unresolved instance entry 触发,子域/custom host 保持当前 TenantContext。

import {
  resolveInstanceLogin,
  resolveInstanceLoginCandidates,
  resolveTenantContextById,
  type LoginIdentifier,
} from '@xid-kit/db'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'

function isLoginIdentifierArray(
  value: LoginIdentifier | readonly LoginIdentifier[],
): value is readonly LoginIdentifier[] {
  return Array.isArray(value)
}

export function loginHintCandidates(loginHint: string): readonly LoginIdentifier[] {
  const trimmed = loginHint.trim()
  const lower = trimmed.toLowerCase()
  if (lower.includes('@')) return [{ kind: 'email', value: lower }]
  if (/^\+[1-9]\d{1,14}$/.test(trimmed)) return [{ kind: 'phone', value: trimmed }]
  if (trimmed === '') return []
  return [
    { kind: 'username', value: lower },
    { kind: 'external_id', value: trimmed },
  ]
}

export async function resolveEntryTenant(
  c: Context<XidHonoEnv>,
  identifier: LoginIdentifier | readonly LoginIdentifier[],
  tenantId?: string | null,
): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!current.resolution?.unresolvedRoot) return current
  const selectedTenantId = tenantId?.trim()
  if (selectedTenantId) {
    const selected = await resolveTenantContextById(c.req.raw, c.env, selectedTenantId)
    if (!selected.ok) throw new AppError('cross_tenant_access_denied')
    return selected.value.tenant
  }
  const result = isLoginIdentifierArray(identifier)
    ? await resolveInstanceLoginCandidates(c.req.raw, c.env, identifier)
    : await resolveInstanceLogin(c.req.raw, c.env, identifier)
  if (!result.ok) return current
  if (result.value.status === 'ambiguous') {
    throw new AppError('invalid_request', {
      longMessage: 'Multiple organizations match this identifier.',
    })
  }
  return result.value.tenant
}

export async function withTenant<T>(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = c.get('tenant')
  c.set('tenant', tenant)
  try {
    return await fn()
  } finally {
    c.set('tenant', previous)
  }
}
