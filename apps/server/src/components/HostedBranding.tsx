import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { useAuth } from '../lib/auth-context'
import { brandFromOrgBranding, useTheme } from '../lib/theme'
import { authConfigQueryOptions, type AuthConfigSearch } from '../routes/sign-in/auth-config-query'

function stringParam(search: Record<string, unknown>, key: keyof AuthConfigSearch) {
  const value = search[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// 与登录页共用 /auth/config 查询缓存;Worker 只在已解析到具体组织时返回 branding。
export function HostedBranding(): null {
  const { api } = useAuth()
  const { setBrand } = useTheme()
  const search: Record<string, unknown> = useSearch({ strict: false })
  const { data } = useQuery(
    authConfigQueryOptions(
      {
        login_hint: stringParam(search, 'login_hint'),
        organization_id: stringParam(search, 'organization_id'),
        client_id: stringParam(search, 'client_id'),
        intent: stringParam(search, 'intent'),
        invitation_token: stringParam(search, 'invitation_token'),
        authz_request_id: stringParam(search, 'authz_request_id'),
      },
      api,
    ),
  )
  const branding = data?.branding ?? null
  useEffect(() => {
    setBrand(brandFromOrgBranding(branding))
  }, [branding, setBrand])
  return null
}
