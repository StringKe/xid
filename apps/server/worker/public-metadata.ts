import type { Hono } from 'hono'
import { WELL_KNOWN_LLMS_PATH, XID_APEX_HOST, XID_WWW_HOST } from '@xid-kit/types'
import type { XidHonoEnv } from './lib/types'

const PERMANENT_REDIRECT_STATUS = 308

export function canonicalWwwRedirectTarget(requestUrl: string | URL): string | null {
  const url = requestUrl instanceof URL ? new URL(requestUrl) : new URL(requestUrl)
  if (url.hostname !== XID_WWW_HOST) return null

  url.protocol = 'https:'
  url.hostname = XID_APEX_HOST
  url.port = ''
  return url.toString()
}

export function wellKnownLlmsRedirectTarget(requestUrl: string | URL): string {
  const url = requestUrl instanceof URL ? new URL(requestUrl) : new URL(requestUrl)
  url.protocol = 'https:'
  url.hostname = XID_APEX_HOST
  url.port = ''
  url.pathname = '/llms.txt'
  url.hash = ''
  return url.toString()
}

export function registerCanonicalHostRedirect(app: Hono<XidHonoEnv>): void {
  app.use('*', async (c, next) => {
    const target = canonicalWwwRedirectTarget(c.req.url)
    if (target) return c.redirect(target, PERMANENT_REDIRECT_STATUS)
    await next()
  })
}

export function registerPublicMetadataRoutes(app: Hono<XidHonoEnv>): void {
  app.get(WELL_KNOWN_LLMS_PATH, (c) =>
    c.redirect(wellKnownLlmsRedirectTarget(c.req.url), PERMANENT_REDIRECT_STATUS),
  )
}
