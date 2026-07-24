import type { Context } from 'hono'
import type { TenantVar, XidHonoEnv } from './types'

export function hostedAuthOriginForTenant(tenant: TenantVar, requestOrigin?: string): string {
  return tenant.hostedAuthOrigin ?? requestOrigin ?? tenant.issuer
}

export function hostedAuthOrigin(c: Context<XidHonoEnv>): string {
  return hostedAuthOriginForTenant(c.get('tenant'), new URL(c.req.url).origin)
}
