import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSmokeConsoleStaticPlugin } from '../../../vite-plugins/smoke-console-static'

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void

const openServers = new Set<ReturnType<typeof createServer>>()
const fixtureDirectories = new Set<string>()

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function startSmokeConsoleServer(distPath: string): Promise<string> {
  const plugin = createSmokeConsoleStaticPlugin(distPath)
  if (plugin === undefined || typeof plugin.configureServer !== 'function') {
    throw new Error('Console smoke plugin is unavailable')
  }

  let middleware: Middleware | undefined
  plugin.configureServer({
    middlewares: {
      use(handler: Middleware) {
        middleware = handler
      },
    },
  } as never)
  if (middleware === undefined) throw new Error('Console smoke middleware was not registered')

  const server = createServer((req, res) => {
    middleware?.(req, res, (error) => {
      if (error) {
        res.statusCode = 500
        res.end(String(error))
        return
      }
      res.statusCode = 418
      res.end('Core route')
    })
  })
  openServers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Server address unavailable')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => closeServer(server)))
  openServers.clear()
  await Promise.all([...fixtureDirectories].map((path) => rm(path, { recursive: true })))
  fixtureDirectories.clear()
})

describe('smoke Console static Vite plugin', () => {
  it('stays disabled without an explicit Console build path', () => {
    expect(createSmokeConsoleStaticPlugin(undefined)).toBeUndefined()
    expect(createSmokeConsoleStaticPlugin('')).toBeUndefined()
  })

  it('serves the Console shell and assets without taking Core routes', async () => {
    const distPath = await mkdtemp(join(tmpdir(), 'xid-console-smoke-plugin-'))
    fixtureDirectories.add(distPath)
    await mkdir(join(distPath, 'assets'))
    await writeFile(join(distPath, 'index.html'), '<!doctype html><div id="root"></div>')
    await writeFile(join(distPath, 'assets', 'app.js'), 'globalThis.consoleSmoke = true')
    const baseUrl = await startSmokeConsoleServer(distPath)

    const root = await fetch(`${baseUrl}/console`)
    expect(root.status).toBe(200)
    expect(root.headers.get('x-xid-route-owner')).toBe('console')
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await root.text()).toContain('id="root"')

    const deepLink = await fetch(`${baseUrl}/console/org/members`)
    expect(deepLink.status).toBe(200)
    expect(deepLink.headers.get('x-xid-route-owner')).toBe('console')
    expect(await deepLink.text()).toContain('id="root"')

    const asset = await fetch(`${baseUrl}/console/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await asset.text()).toContain('consoleSmoke')

    const missingAsset = await fetch(`${baseUrl}/console/assets/missing.js`)
    expect(missingAsset.status).toBe(404)
    expect(missingAsset.headers.get('x-xid-route-owner')).toBe('console')

    const coreRoute = await fetch(`${baseUrl}/v1/health`)
    expect(coreRoute.status).toBe(418)
    expect(await coreRoute.text()).toBe('Core route')
  })

  it('keeps account aliases on the same host and preserves the query', async () => {
    const distPath = await mkdtemp(join(tmpdir(), 'xid-console-smoke-plugin-'))
    fixtureDirectories.add(distPath)
    await writeFile(join(distPath, 'index.html'), '<!doctype html><div id="root"></div>')
    const baseUrl = await startSmokeConsoleServer(distPath)

    const response = await fetch(`${baseUrl}/console/sessions/?source=smoke`, {
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/account/sessions?source=smoke')
    expect(response.headers.get('x-xid-route-owner')).toBe('console')
  })
})
