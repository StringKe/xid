import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

const CONSOLE_ROOT = '/console'
const CONSOLE_SHELL = '/console/'
const ROUTE_OWNER_HEADER = 'X-XID-Route-Owner'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
} as const

function isConsolePath(pathname: string): boolean {
  return pathname === CONSOLE_ROOT || pathname.startsWith(`${CONSOLE_ROOT}/`)
}

function isStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith('/console/assets/')) return true
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1)
  return filename.includes('.')
}

function redirectAccountAlias(pathname: string): string | null {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (normalized === '/console/sessions') return '/account/sessions'
  if (normalized === '/console/security') return '/account/security'
  return null
}

function setConsoleOwner(res: { setHeader(name: string, value: string | number): void }): void {
  res.setHeader(ROUTE_OWNER_HEADER, 'console')
}

function endNotFound(res: {
  end(body?: string): void
  setHeader(name: string, value: string | number): void
  statusCode: number
}): void {
  res.statusCode = 404
  setConsoleOwner(res)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end('Not Found')
}

async function readStaticFile(path: string): Promise<Buffer | null> {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile()) return null
    return await readFile(path)
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null
    }
    throw error
  }
}

function resolveConsoleFile(distPath: string, pathname: string): string | null {
  let relativePath: string
  try {
    relativePath = decodeURIComponent(pathname.slice(CONSOLE_SHELL.length))
  } catch {
    return null
  }
  const candidate = resolve(distPath, relativePath)
  if (candidate !== distPath && !candidate.startsWith(`${distPath}${sep}`)) return null
  return candidate
}

async function serveFile(
  req: { method?: string },
  res: {
    end(body?: Buffer): void
    setHeader(name: string, value: string | number): void
    statusCode: number
  },
  path: string,
): Promise<boolean> {
  const body = await readStaticFile(path)
  if (body === null) return false

  res.statusCode = 200
  setConsoleOwner(res)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', body.byteLength)
  res.setHeader(
    'Content-Type',
    CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
  )
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}

export function createSmokeConsoleStaticPlugin(distPath: string | undefined): Plugin | undefined {
  if (distPath === undefined || distPath.length === 0) return undefined
  const absoluteDistPath = resolve(distPath)
  const shellPath = resolve(absoluteDistPath, 'index.html')

  return {
    name: 'xid-smoke-console-static',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const handleRequest = async () => {
          const url = new URL(req.url ?? '/', 'http://xid.local')
          const accountPath = redirectAccountAlias(url.pathname)
          if (accountPath !== null) {
            res.statusCode = 302
            setConsoleOwner(res)
            res.setHeader('Location', `${accountPath}${url.search}`)
            res.end()
            return
          }
          if (!isConsolePath(url.pathname)) {
            next()
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            endNotFound(res)
            return
          }

          if (url.pathname !== CONSOLE_ROOT && url.pathname !== CONSOLE_SHELL) {
            const filePath = resolveConsoleFile(absoluteDistPath, url.pathname)
            if (filePath === null) {
              endNotFound(res)
              return
            }
            if (await serveFile(req, res, filePath)) return
            if (isStaticAssetPath(url.pathname)) {
              endNotFound(res)
              return
            }
          }

          if (!(await serveFile(req, res, shellPath))) {
            res.statusCode = 503
            setConsoleOwner(res)
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end('Console smoke build is unavailable.')
          }
        }
        void handleRequest().catch(next)
      })
    },
  }
}
