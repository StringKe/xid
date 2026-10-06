// 根域 Hosted Auth resolver:instance entry(未解析,或仅由 session cookie 推出租户)按显式组织、
// identifier 选租户;子域/custom host 保持当前 TenantContext。

import {
  resolveInstanceLogin,
  resolveInstanceLoginCandidates,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextById,
  type InstanceLoginMatch,
  type LoginIdentifier,
} from '@xid-kit/db'
import { normalizePhoneNumber } from '@xid-kit/types'
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

type EntryResolution =
  | { kind: 'tenant'; tenant: TenantVar }
  | { kind: 'ambiguous'; matches: readonly InstanceLoginMatch[] }

function isLoginIdentifierArray(
  value: LoginIdentifier | readonly LoginIdentifier[],
): value is readonly LoginIdentifier[] {
  return Array.isArray(value)
}

export function isInstanceEntryContext(tenant: TenantVar): boolean {
  return (
    tenant.resolution?.unresolvedRoot === true || tenant.resolution?.sessionDerivedRoot === true
  )
}

export function loginHintCandidates(loginHint: string): readonly LoginIdentifier[] {
  const trimmed = loginHint.trim()
  const lower = trimmed.toLowerCase()
  if (lower.includes('@')) return [{ kind: 'email', value: lower }]
  const phone = trimmed.startsWith('+') ? normalizePhoneNumber(trimmed) : null
  if (phone) return [{ kind: 'phone', value: phone }]
  if (trimmed === '') return []
  return [
    { kind: 'username', value: lower },
    { kind: 'external_id', value: trimmed },
  ]
}

async function resolveApplicationOrInvitation(
  c: Context<XidHonoEnv>,
  input: {
    tenantId: string | null
    applicationClientId: string | null
    invitationToken: string | null
  },
): Promise<TenantVar | null> {
  const { applicationClientId, invitationToken } = input
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
  if (!applicationClientId) return null
  // OIDC Hosted Auth is owned by the registered Application. Resolve client_id again at every
  // credential boundary and require any opaque Tenant hint to agree, so a query/body edit cannot
  // move an authorization transaction into another isolation root.
  const applicationTenant = await resolveTenantContextByApplicationClientId(
    c.req.raw,
    c.env,
    applicationClientId,
  )
  if (!applicationTenant.ok) throw new AppError('cross_tenant_access_denied')
  if (input.tenantId && input.tenantId !== applicationTenant.value.tenantId) {
    throw new AppError('cross_tenant_access_denied')
  }
  return applicationTenant.value
}

async function resolveEntry(
  c: Context<XidHonoEnv>,
  identifier: LoginIdentifier | readonly LoginIdentifier[],
  tenantId: string | null | undefined,
  flow: EntryFlow,
): Promise<EntryResolution> {
  const current = c.get('tenant')
  const intent = flow.intent?.trim() || null
  if (intent !== null && !isHostedAuthIntent(intent)) throw new AppError('invalid_request')
  const applicationClientId = flow.applicationClientId?.trim() || null
  const invitationToken = flow.invitationToken?.trim() || null
  if (
    (applicationClientId && (invitationToken || isProductSignUpIntent(intent))) ||
    (isApplicationSignUpIntent(intent) && !applicationClientId)
  ) {
    throw new AppError('invalid_request')
  }
  const selectedTenantId = tenantId?.trim() || null
  const flowTenant = await resolveApplicationOrInvitation(c, {
    tenantId: selectedTenantId,
    applicationClientId,
    invitationToken,
  })
  if (flowTenant) return { kind: 'tenant', tenant: flowTenant }
  if (!isInstanceEntryContext(current)) return { kind: 'tenant', tenant: current }

  // Public self-service onboarding is intentionally independent from account/domain discovery.
  if (isProductSignUpIntent(intent)) return { kind: 'tenant', tenant: current }

  if (selectedTenantId) {
    const selected = await resolveTenantContextById(c.req.raw, c.env, selectedTenantId)
    if (!selected.ok) throw new AppError('cross_tenant_access_denied')
    return { kind: 'tenant', tenant: selected.value.tenant }
  }
  // cookie 推出的租户只让位于显式组织选择;identifier 不改选租户,guest 转正等仪式留在当前租户。
  if (!current.resolution?.unresolvedRoot) return { kind: 'tenant', tenant: current }
  const result = isLoginIdentifierArray(identifier)
    ? await resolveInstanceLoginCandidates(c.req.raw, c.env, identifier)
    : await resolveInstanceLogin(c.req.raw, c.env, identifier)
  if (!result.ok) return { kind: 'tenant', tenant: current }
  if (result.value.status === 'ambiguous')
    return { kind: 'ambiguous', matches: result.value.matches }
  return { kind: 'tenant', tenant: result.value.tenant }
}

// identifier 对应多个组织时抛 organization_selection_required,由 Hosted UI 带 login_hint 展示组织选择。
export async function resolveEntryTenant(
  c: Context<XidHonoEnv>,
  identifier: LoginIdentifier | readonly LoginIdentifier[],
  tenantId?: string | null,
  flow: EntryFlow = {},
): Promise<TenantVar> {
  const resolution = await resolveEntry(c, identifier, tenantId, flow)
  if (resolution.kind === 'ambiguous') throw new AppError('organization_selection_required')
  return resolution.tenant
}

// 恒 200 的发送端点(找回密码、重发验证)不能要求选组织:返回全部匹配组织,由调用方逐个处理。
export async function resolveEntryTenants(
  c: Context<XidHonoEnv>,
  identifier: LoginIdentifier,
  tenantId?: string | null,
  flow: EntryFlow = {},
): Promise<readonly TenantVar[]> {
  const resolution = await resolveEntry(c, identifier, tenantId, flow)
  if (resolution.kind === 'tenant') return [resolution.tenant]
  const tenants = await Promise.all(
    resolution.matches.map((match) => resolveTenantContextById(c.req.raw, c.env, match.tenantId)),
  )
  return tenants.flatMap((tenant) => (tenant.ok ? [tenant.value.tenant] : []))
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
