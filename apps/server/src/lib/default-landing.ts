import { useQuery } from '@tanstack/react-query'
import type { DefaultLandingPath } from '@xid-kit/types'
import { authConfigQueryOptions } from '../routes/sign-in/auth-config-query'
import { DEFAULT_PUBLIC_AUTH_CONFIG } from '../routes/sign-in/auth-config'
import { useAuth } from './auth-context'

// Worker 按请求 host 判断此处是否路由了 Console;拿到结果前用每个 host 都存在的 /account。
export function useDefaultLandingPath(): DefaultLandingPath {
  const { api } = useAuth()
  const { data } = useQuery(authConfigQueryOptions({}, api))
  return data?.defaultLandingPath ?? DEFAULT_PUBLIC_AUTH_CONFIG.defaultLandingPath
}
