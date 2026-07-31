// 根域 Hosted Auth resolver:仅 unresolved instance entry 触发,子域/custom host 保持当前 TenantContext。

import {
  resolveInstanceLogin,
  resolveInstanceLoginCandidates,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextById,
  type LoginIdentifier,
} from '@xid-kit/db'
import type { Context } from 'hono'
import {
  isApplicationSignUpIntent,
  isHostedAuthIntent,
  isProductSignUpIntent,
} from '../../shared/hosted-auth-intent'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { resolveInvitationTenant } from '../auth/invitations'

type EntryFlow = {
  intent?: string | null
  invitationToken?: string | null
  applicationClientId?: string | null
}

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
  flow: EntryFlow = {},
): Promise<TenantVar> {
  const current = c.get('tenant')
  const intent = flow.intent?.trim() || null
  if (intent !== null && !isHostedAuthIntent(intent)) throw new AppError('invalid_request')
  const applicationClientId = flow.applicationClientId?.trim() || null
  const invitationToken = flow.invitationToken?.trim()
  if (
    (applicationClientId && (invitationToken || isProductSignUpIntent(intent))) ||
    (isApplicationSignUpIntent(intent) && !applicationClientId)
  ) {
    throw new AppError('invalid_request')
  }
  if (invitationToken) {
    const invitedTenant = await resolveInvitationTenant(c, invitationToken)
    if (!invitedTenant) throw new AppError('invitation_invalid')
    if (applicationClientId) {
      const applicationTenant = await resolveTenantContextByApplicationClientId(
        c.req.raw,
        c.env,
        applicationClientId,
      )
      if (!applicationTenant.ok || applicationTenant.value.tenantId !== invitedTenant.tenantId) {
        throw new AppError('cross_tenant_access_denied')
      }
    }
    return invitedTenant
  }

  // OIDC Hosted Auth is owned by the registered Application. Resolve client_id again at every
  // credential boundary and require any opaque Tenant hint to agree, so a query/body edit cannot
  // move an authorization transaction into another isolation root.
  if (applicationClientId) {
    const applicationTenant = await resolveTenantContextByApplicationClientId(
      c.req.raw,
      c.env,
      applicationClientId,
    )
    if (!applicationTenant.ok) throw new AppError('cross_tenant_access_denied')
    const selectedTenantId = tenantId?.trim()
    if (selectedTenantId && selectedTenantId !== applicationTenant.value.tenantId) {
      throw new AppError('cross_tenant_access_denied')
    }
    return applicationTenant.value
  }
  if (isApplicationSignUpIntent(intent)) throw new AppError('invalid_request')
  if (!current.resolution?.unresolvedRoot) return current

  // Public self-service onboarding is intentionally independent from account/domain discovery.
  // Invitation routing above remains higher priority because it joins an existing Tenant.
  if (isProductSignUpIntent(intent)) return current

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
