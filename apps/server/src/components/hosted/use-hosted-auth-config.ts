import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useOrganizationLabel } from '@xid-kit/web-ui/display-names'
import { useAuth } from '../../lib/auth-context'
import {
  DEFAULT_PUBLIC_AUTH_CONFIG,
  type PublicHostedAuthConfig,
} from '../../routes/sign-in/auth-config'
import {
  authConfigQueryOptions,
  authConfigSearchFrom,
} from '../../routes/sign-in/auth-config-query'

export type HostedAuthConfigState = {
  config: PublicHostedAuthConfig
  isPending: boolean
}

// 上下文栏与页面标题共用的组织名按界面语言显示。
export function useLocalizedAuthConfig(data: PublicHostedAuthConfig): PublicHostedAuthConfig {
  const organizationLabel = useOrganizationLabel()
  return useMemo(() => {
    const name = data.context.organizationName
    if (name === null) return data
    return { ...data, context: { ...data.context, organizationName: organizationLabel({ name }) } }
  }, [data, organizationLabel])
}

// 所有 Hosted Auth 页面按当前 URL 读同一份 /auth/config 缓存:品牌、上下文栏与登录方法同源。
export function useHostedAuthConfig(): HostedAuthConfigState {
  const { api } = useAuth()
  const search: Record<string, unknown> = useSearch({ strict: false })
  const query = useQuery(authConfigQueryOptions(authConfigSearchFrom(search), api))
  const config = useLocalizedAuthConfig(query.data ?? DEFAULT_PUBLIC_AUTH_CONFIG)
  return { config, isPending: query.isPending }
}
