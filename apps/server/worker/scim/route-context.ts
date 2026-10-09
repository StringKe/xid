// SCIM 资源路由的公共前置:路径 organization_id 与 TenantContext 一致、Bearer 鉴权、投影参数。

import { createTenantDb } from '@xid-kit/db'
import type { Result, TenantContext } from '@xid-kit/types'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { authBearer } from './auth'
import type { DirectoryRow } from './auth'
import { parseScimProjection } from './projection'
import type { ScimProjection } from './projection'
import { scimError } from './shared'

export type ScimRequestContext = {
  tenantId: string
  tenant: TenantContext
  directory: DirectoryRow
  db: ReturnType<typeof createTenantDb>
  projection: ScimProjection | null
}

export async function openScimRequest(
  c: Context<XidHonoEnv>,
): Promise<Result<ScimRequestContext, Response>> {
  const tenantId = c.req.param('organization_id') ?? ''
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) {
    return { ok: false, error: scimError(c, 403, 'organization mismatch') }
  }
  const directory = await authBearer(c, tenantId)
  if (!directory) {
    return { ok: false, error: scimError(c, 401, 'Unauthorized', { addWwwAuth: true }) }
  }
  const projection = parseScimProjection(
    c.req.query('attributes'),
    c.req.query('excludedAttributes'),
  )
  if (!projection.ok) {
    return {
      ok: false,
      error: scimError(c, 400, projection.error.detail, projection.error.scimType),
    }
  }
  return {
    ok: true,
    value: {
      tenantId,
      tenant,
      directory,
      db: createTenantDb(c.env.DB, tenant),
      projection: projection.projection,
    },
  }
}
