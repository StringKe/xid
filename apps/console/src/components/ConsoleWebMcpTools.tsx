import { useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '@xid-kit/web-ui/session'
import { useLocation } from '@xid-kit/web-ui/tanstack-router'
import {
  createConsoleShellWebMcpTools,
  createConsoleWebMcpTools,
} from '../lib/webmcp/register-console-tools'
import { syncWebMcpTools, unregisterWebMcpTools } from '../lib/webmcp/register-tools'

export function ConsoleWebMcpTools(): ReactNode {
  const { pathname } = useLocation()
  const router = useRouter()
  const { status, user, activeOrg, organizations, session, api, setActiveOrganization } = useAuth()

  useEffect(() => {
    const controller = new AbortController()

    void syncWebMcpTools({
      signal: controller.signal,
      buildTools: () => {
        const navigate = (to: string): void => {
          if (to === '/console/sessions' || to === '/console/security') {
            location.assign(to)
            return
          }
          void router.navigate({ href: to })
        }
        const sharedOptions = {
          navigate,
          getPathname: () => location.pathname,
          getPageTitle: () => document.title,
        }

        if (status === 'authenticated' && user) {
          return createConsoleWebMcpTools({
            ...sharedOptions,
            api,
            setActiveOrganization,
            me: {
              user,
              activeOrg,
              organizations,
              session,
            },
          })
        }
        return status === 'loading' ? [] : createConsoleShellWebMcpTools(sharedOptions)
      },
    })

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

  useEffect(() => unregisterWebMcpTools, [])

  return null
}
