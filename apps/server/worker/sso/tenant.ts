// Enterprise SSO root entry resolver.
// HRD can discover a tenant from an email, but IdP callbacks only carry connection/state.
// Resolve the final tenant on the server so root Hosted Auth is not pinned to the entry org.

import {
  resolveTenantContextById,
  resolveTenantContextBySamlServiceProvider,
  resolveTenantContextBySsoConnection,
} from '@xid-kit/db'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'

function shouldResolveProtocolPathTenant(c: Context<XidHonoEnv>, current: TenantVar): boolean {
  if (current.resolution?.unresolvedRoot) return true
  if (!current.resolution?.primaryDomain) return false
  // A root refresh cookie may have resolved a different tenant before the callback handler runs.
  // At the instance issuer origin the protocol-owned path identifier is authoritative; tenant
  // subdomains and custom hostnames remain host-scoped and are checked again by the scoped query.
  return new URL(c.req.raw.url).origin === new URL(current.issuer).origin
}

export async function resolveSsoConnectionTenant(
  c: Context<XidHonoEnv>,
  connectionId: string,
): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!shouldResolveProtocolPathTenant(c, current)) return current
  const result = await resolveTenantContextBySsoConnection(c.req.raw, c.env, connectionId)
  if (!result.ok) throw new AppError('connection_not_found')
  return result.value.tenant
}

export async function resolveSsoFlowTenant(
  c: Context<XidHonoEnv>,
  tenantId: string,
): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!current.resolution?.unresolvedRoot) return current
  const result = await resolveTenantContextById(c.req.raw, c.env, tenantId)
  if (!result.ok) throw new AppError('cross_tenant_access_denied')
  return result.value.tenant
}

export async function resolveSamlServiceProviderTenant(
  c: Context<XidHonoEnv>,
  appId: string,
): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!shouldResolveProtocolPathTenant(c, current)) return current
  const result = await resolveTenantContextBySamlServiceProvider(c.req.raw, c.env, appId)
  if (!result.ok) throw new AppError('connection_not_found')
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
