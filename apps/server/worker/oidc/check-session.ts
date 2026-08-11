// OIDC Session Management:check_session iframe(postMessage OP iframe)。

import { getCookie, setCookie } from 'hono/cookie'
import type { Context, Hono } from 'hono'
import { AppError } from '../lib/errors'
import { readSession } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { findClient } from './shared'
import { computeOpSessionState } from './session-state'

const OPBS_COOKIE = '__Host-xid.opbs'
const OPBS_MAX_AGE_SEC = 365 * 24 * 60 * 60

function ensureOpbsSalt(c: Context<XidHonoEnv>): string {
  const existing = getCookie(c, OPBS_COOKIE)
  if (existing && existing.length >= 16) return existing
  const salt = crypto.randomUUID()
  setCookie(c, OPBS_COOKIE, salt, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
    maxAge: OPBS_MAX_AGE_SEC,
  })
  return salt
}

function checkSessionHtml(input: {
  issuer: string
  salt: string
  sessionKey: string
  clientId: string
  allowedOrigins: readonly string[]
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>OP Check Session</title></head>
<body>
<script>
(function () {
  var issuer = ${JSON.stringify(input.issuer)};
  var salt = ${JSON.stringify(input.salt)};
  var sessionKey = ${JSON.stringify(input.sessionKey)};
  var clientId = ${JSON.stringify(input.clientId)};
  var allowedOrigins = new Set(${JSON.stringify(input.allowedOrigins)});

  async function sha256Base64Url(value) {
    var data = new TextEncoder().encode(value);
    var digest = await crypto.subtle.digest('SHA-256', data);
    var bytes = new Uint8Array(digest);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replaceAll('=', '');
  }

  async function computeOpSessionState(clientId) {
    var browserState = await sha256Base64Url(clientId + ' ' + issuer + ' ' + sessionKey + ' ' + salt);
    return sha256Base64Url(clientId + ' ' + issuer + ' ' + browserState + ' ' + salt);
  }

  window.addEventListener('message', function (event) {
    if (typeof event.data !== 'string') return;
    var parts = event.data.split(' ');
    if (parts.length !== 2 || parts[0] !== clientId) return;
    if (!allowedOrigins.has(event.origin)) return;
    var rpSessionState = parts[1];
    computeOpSessionState(clientId).then(function (opSessionState) {
      var status = (rpSessionState === opSessionState) ? 'unchanged' : 'changed';
      event.source && event.source.postMessage(clientId + ' ' + rpSessionState + ' ' + status, event.origin);
    });
  }, false);
})();
</script>
</body>
</html>`
}

async function handleCheckSession(c: Context<XidHonoEnv>): Promise<Response> {
  const clientId = c.req.query('client_id')
  if (!clientId) throw new AppError('invalid_request', { httpStatus: 400 })
  const client = await findClient(c, clientId)
  if (!client) throw new AppError('invalid_request', { httpStatus: 400 })
  const allowedOrigins = [
    ...new Set(
      client.redirectUris.flatMap((redirectUri) => {
        try {
          const origin = new URL(redirectUri).origin
          return origin === 'null' ? [] : [origin]
        } catch {
          return []
        }
      }),
    ),
  ]
  if (allowedOrigins.length === 0) {
    throw new AppError('invalid_request', { httpStatus: 400 })
  }
  const session = c.get('session') ?? (await readSession(c))
  const ctx = c.get('tenant')
  const salt = ensureOpbsSalt(c)
  const sessionKey = session?.sessionId ?? ''
  const html = checkSessionHtml({
    issuer: ctx.issuer,
    salt,
    sessionKey,
    clientId,
    allowedOrigins,
  })
  return c.html(html, 200, {
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; frame-ancestors ${allowedOrigins.join(' ')}`,
  })
}

export async function opSessionStateForClient(input: {
  clientId: string
  issuer: string
  session: SessionData | null
  salt: string
}): Promise<string> {
  return computeOpSessionState({
    clientId: input.clientId,
    issuer: input.issuer,
    sessionKey: input.session?.sessionId ?? '',
    salt: input.salt,
  })
}

export function registerCheckSessionRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/check_session', handleCheckSession)
}
