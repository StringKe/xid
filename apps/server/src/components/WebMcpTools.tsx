// WebMCP 工具注册:公开 docs 发现 + 已登录 console 管理操作(Chrome origin trial,渐进增强)。

import { useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth-context'
import { useLocation } from '../lib/router'
import {
  createConsoleShellWebMcpTools,
  createConsoleWebMcpTools,
} from '../lib/webmcp/register-console-tools'
import { createPublicWebMcpTools } from '../lib/webmcp/register-public-tools'
import { syncWebMcpTools, unregisterWebMcpTools } from '../lib/webmcp/register-tools'
import { getWebMcpSurfaceKind } from '../lib/webmcp/support'

export function WebMcpTools(): ReactNode {
  const { pathname } = useLocation()
  const router = useRouter()
  const { status, user, activeOrg, organizations, session, api, setActiveOrganization } = useAuth()

  useEffect(() => {
    const controller = new AbortController()
    const surfaceKind = getWebMcpSurfaceKind(pathname)

    if (surfaceKind === 'blocked') {
      unregisterWebMcpTools()
      return () => controller.abort()
    }

    void syncWebMcpTools({
      signal: controller.signal,
      buildTools: () => {
        const navigate = (to: string): void => {
          void router.navigate({ to })
        }

        const sharedOptions = {
          navigate,
          getPathname: () => location.pathname,
          getPageTitle: () => document.title,
        }

        const tools = [...createPublicWebMcpTools(sharedOptions)]

        if (surfaceKind === 'console') {
          if (status === 'authenticated' && user) {
            tools.push(
              ...createConsoleWebMcpTools({
                ...sharedOptions,
                api,
                setActiveOrganization,
                me: {
                  user,
                  activeOrg,
                  organizations,
                  session,
                },
              }),
            )
          } else if (status !== 'loading') {
            tools.push(...createConsoleShellWebMcpTools(sharedOptions))
          }
        }

        return tools
      },
    })

    // 仅取消进行中的等待;不注销已注册工具,避免 StrictMode 重挂载时出现空窗。
    return () => controller.abort()
  }, [
    pathname,
    router,
    status,
    user,
    activeOrg,
    organizations,
    session,
    api,
    setActiveOrganization,
  ])

  return null
}
