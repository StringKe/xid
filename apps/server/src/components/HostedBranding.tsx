import { useEffect } from 'react'
import { brandFromOrgBranding, useTheme } from '../lib/theme'
import { useHostedAuthConfig } from './hosted/use-hosted-auth-config'

// 与登录页共用 /auth/config 查询缓存;Worker 只在已解析到具体组织时返回 branding。
export function HostedBranding(): null {
  const { setBrand } = useTheme()
  const { config } = useHostedAuthConfig()
  const branding = config.branding
  useEffect(() => {
    setBrand(brandFromOrgBranding(branding))
  }, [branding, setBrand])
  return null
}
