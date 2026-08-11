// RFC 8252 s.7.3：127.0.0.1 + OS 分配端口，只服务一次 GET /callback。仅 main。

import { createServer } from 'node:http'
import type { Server } from 'node:http'

import type { LoopbackCallbackServer } from '../types'

const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

export async function startLoopbackServer(): Promise<LoopbackCallbackServer> {
  const server = await bindServer()
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('[xid-electron] loopback server: unexpected address type')
  }
  const port = address.port
  const redirectUri = `http://127.0.0.1:${port}/callback`

  return {
    redirectUri,
    waitForCallback: (options) => waitForCallback(server, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    close: () => closeServer(server),
  }
}

function bindServer(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      resolve(server)
    })
    server.on('error', reject)
  })
}

function waitForCallback(server: Server, timeoutMs: number): Promise<URL> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('[xid-electron] loopback callback timed out'))
      void closeServer(server)
    }, timeoutMs)

    server.on('request', (req, res) => {
      const rawUrl = req.url ?? ''
      // 忽略 favicon 等非 /callback，避免误消费登录等待。
      if (!rawUrl.startsWith('/callback')) {
        res.writeHead(404).end()
        return
      }

      clearTimeout(timer)

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(CALLBACK_HTML)

      // 拼绝对 URL 供下游 parseCallbackUrl。
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const fullUrl = new URL(`http://127.0.0.1:${port}${rawUrl}`)
      void closeServer(server).catch(() => undefined)
      resolve(fullUrl)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

const CALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in complete</title></head>
<body><p>You have signed in. This window can be closed.</p></body>
</html>`
