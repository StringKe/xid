// 多租户实例早期在根域登记的 passkey 绑定的是实例主域(rp_id 为 NULL)。WebAuthn 允许子域 origin 以父域
// 作为 rpId,所以在组织子域上仍能用这些凭证:只对 rp_id 为 NULL 的凭证额外接受实例主域,
// 新登记的凭证一律绑定组织 rpId,不能走实例主域。

import type { TenantVar } from '../lib/types'

export function instancePrimaryHost(tenant: TenantVar): string {
  return new URL(tenant.issuer).hostname
}

// 组织 rpId 是实例主域的子域时返回实例主域;单租户、自定义域或根域上下文返回 null。
export function earlierPasskeyRpId(tenant: TenantVar): string | null {
  const primary = instancePrimaryHost(tenant)
  if (tenant.rpId === primary || !tenant.rpId.endsWith(`.${primary}`)) return null
  return primary
}

// 只在组织 rpId 主机上提供:浏览器要求父域 rpId 是当前主机的可注册后缀。
export function earlierPasskeyRpIdForRequest(requestUrl: string, tenant: TenantVar): string | null {
  if (new URL(requestUrl).hostname !== tenant.rpId) return null
  return earlierPasskeyRpId(tenant)
}

export function isEarlierPasskey(tenant: TenantVar, credential: { rpId: string | null }): boolean {
  return credential.rpId === null && earlierPasskeyRpId(tenant) !== null
}

// 验签时除组织 rpId 外额外接受的 rpId。
export function additionalRpIdsFor(
  tenant: TenantVar,
  credential: { rpId: string | null },
): string[] {
  const earlier = earlierPasskeyRpId(tenant)
  return credential.rpId === null && earlier ? [earlier] : []
}
