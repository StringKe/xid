import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
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

// 所有 Hosted Auth 页面按当前 URL 读同一份 /auth/config 缓存:品牌、上下文栏与登录方法同源。
export function useHostedAuthConfig(): HostedAuthConfigState {
  const { api } = useAuth()
  const search: Record<string, unknown> = useSearch({ strict: false })
  const query = useQuery(authConfigQueryOptions(authConfigSearchFrom(search), api))
  return { config: query.data ?? DEFAULT_PUBLIC_AUTH_CONFIG, isPending: query.isPending }
}
