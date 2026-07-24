import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'

function unsupported(c: Context<XidHonoEnv>): Response {
  return c.json(
    {
      error: 'unsupported_response_type',
      error_description: 'Shared Signals Framework transmitter is not supported.',
    },
    501,
    { 'cache-control': 'no-store' },
  )
}

export function registerSsfRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/.well-known/ssf-configuration', (c) => unsupported(c))
  app.get('/.well-known/security-events-configuration', (c) => unsupported(c))
  app.get('/.well-known/risc-configuration', (c) => unsupported(c))
  app.get('/ssf/configuration', (c) => unsupported(c))
  app.get('/ssf/status', (c) => unsupported(c))
  app.post('/ssf/stream', (c) => unsupported(c))
  app.get('/ssf/streams', (c) => unsupported(c))
  app.post('/caep/events', (c) => unsupported(c))
  app.post('/risc/events', (c) => unsupported(c))
}
