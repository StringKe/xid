// 一次性认证 token 的 org hint 解析。payload 只用于选择 TenantContext,真正授权仍依赖 JWT 验签和 DB 消费。
// 根域上 session cookie 推出的租户不固定 token 租户:多组织用户持 A 的 cookie 打开 B 的链接仍按 B 处理。

import { base64UrlDecodeToString } from '@xid-kit/crypto'
import { resolveTenantContextByIssuer } from '@xid-kit/db'
import type { XidErrorCode } from '@xid-kit/types'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'

type TokenTenantHint = {
  issuer?: string
  tenantId?: string
}

function tokenTenantHint(rawToken: string): TokenTenantHint {
  const parts = rawToken.split('.')
  if (parts.length !== 3 || !parts[1]) return {}
  try {
    const payload = JSON.parse(base64UrlDecodeToString(parts[1])) as {
      iss?: unknown
      tenant_id?: unknown
    }
    return {
      issuer: typeof payload.iss === 'string' ? payload.iss : undefined,
      tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : undefined,
    }
  } catch {
    return {}
  }
}

export async function resolveTokenTenant(
  c: Context<XidHonoEnv>,
  rawToken: string,
  invalidCode: XidErrorCode,
): Promise<TenantVar> {
  const current = c.get('tenant')
  const sessionDerivedRoot = current.resolution?.sessionDerivedRoot === true
  if (!current.resolution?.unresolvedRoot && !sessionDerivedRoot) return current
  const hint = tokenTenantHint(rawToken)
  if (sessionDerivedRoot && (!hint.issuer || hint.tenantId === current.tenantId)) return current
  if (!hint.issuer) {
    throw new AppError(invalidCode, { logReason: 'token_tenant_hint_missing' })
  }
  const result = await resolveTenantContextByIssuer(c.req.raw, c.env, hint.issuer, {
    tenantId: hint.tenantId,
  })
  if (!result.ok) {
    throw new AppError(invalidCode, { logReason: 'token_tenant_resolution_failed' })
  }
  return result.value.tenant
}
