// 账户门户与 Hosted Auth 用同一组织品牌:名称先取 /auth/config 上下文,实例根入口(会话恢复的租户)
// 没有上下文名时取本人所在租户的顶层组织;都没有才回落实例品牌。
// logo 只用组织上传的;组织没有 logo 时返回 null,由调用方显示组织首字母。

import { useOrganizationLabel } from '@xid-kit/web-ui/display-names'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { useAuth } from '../../lib/auth-context'
import { DEFAULT_BRAND, brandLogoUrl, useTheme } from '../../lib/theme'

export type AccountBrand = {
  name: string
  logoUrl: string | null
}

const INSTANCE_NAME = DEFAULT_BRAND.appName ?? 'XID'

function useTenantOrganizationName(): string | null {
  const { organizations } = useAuth()
  const organizationLabel = useOrganizationLabel()
  const topLevel = organizations.filter((organization) => organization.parentOrgId === null)
  const tenantOrganization = topLevel.length === 1 ? topLevel[0] : undefined
  return tenantOrganization ? organizationLabel(tenantOrganization) : null
}

export function useAccountBrand(): AccountBrand {
  const { brand, scheme } = useTheme()
  const { config } = useHostedAuthConfig()
  const tenantName = useTenantOrganizationName()
  const organizationName = config.context.organizationName ?? tenantName
  const logoUrl = brandLogoUrl(brand, scheme) ?? null
  if (!organizationName) {
    return { name: INSTANCE_NAME, logoUrl: DEFAULT_BRAND.logoUrl ?? null }
  }
  const tenantLogoUrl = logoUrl !== null && logoUrl !== DEFAULT_BRAND.logoUrl ? logoUrl : null
  return { name: organizationName, logoUrl: tenantLogoUrl }
}
