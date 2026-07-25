import { createConsoleShellWebMcpTools } from './register-console-tools'
import { createPublicWebMcpTools } from './register-public-tools'
import { syncWebMcpTools } from './register-tools'
import { getWebMcpSurfaceKind } from './support'

function navigateWithLocation(to: string): void {
  if (to === location.pathname + location.search) return
  location.assign(to)
}

const sharedBootstrapOptions = {
  navigate: navigateWithLocation,
  getPathname: () => location.pathname,
  getPageTitle: () => document.title,
}

function buildBootstrapTools(surfaceKind: ReturnType<typeof getWebMcpSurfaceKind>) {
  const tools = [...createPublicWebMcpTools(sharedBootstrapOptions)]
  if (surfaceKind === 'console') {
    tools.push(...createConsoleShellWebMcpTools(sharedBootstrapOptions))
  }
  return tools
}

export function bootstrapPublicWebMcp(): void {
  if (typeof document === 'undefined') return

  const surfaceKind = getWebMcpSurfaceKind(location.pathname)
  if (surfaceKind === 'blocked') return

  void (async () => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const registered = await syncWebMcpTools({
        buildTools: () => buildBootstrapTools(surfaceKind),
      })
      if (registered) return
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  })()
}
