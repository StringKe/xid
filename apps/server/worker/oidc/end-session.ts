// /end_session 端点(03 章 7、OIDC RP-Initiated Logout):验证 id_token_hint,撤销 session,
// 校验 post_logout_redirect_uri 后回跳;对绑定 RP 发 back-channel logout_token(首选,更可靠)。
// 铁律:id_token_hint 验签用 TenantContext 公钥集;redirect 精确匹配注册的 post_logout_redirect_uris。

import { signJwt, verifyJwt } from '@xid-kit/crypto'
import type { Context, Hono } from 'hono'
import { readSession, revokeSession } from '../lib/session'
import { escapeHtml } from '../lib/error-page'
import type { XidHonoEnv } from '../lib/types'
import { buildVerifyKeySet, findClient, loadActiveSigner } from './shared'
import { BACKCHANNEL_LOGOUT_TOKEN_TTL_SEC } from '../lib/ttl'

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'

type RawParams = Record<string, string>

async function parseParams(c: Context<XidHonoEnv>): Promise<RawParams> {
  if (c.req.method === 'POST') {
    return Object.fromEntries(await c.req.raw.clone().formData()) as RawParams
  }
  return Object.fromEntries(new URL(c.req.url).searchParams) as RawParams
}

// 验证 id_token_hint:本 issuer 签发(签名有效,iss 匹配)。返回 payload 或 null。
async function verifyIdTokenHint(
  c: Context<XidHonoEnv>,
  hint: string | undefined,
): Promise<{ sub?: string; aud?: string | readonly string[]; sid?: string } | null> {
  if (!hint) return null
  const ctx = c.get('tenant')
  const keySet = await buildVerifyKeySet(ctx)
  // 已登出场景 id_token 可能已过期,allowExpired 跳过 exp(OIDC RP-Init 允许过期 hint);
  // nbf/iat 仍按默认 60s 容差校验,不放过未来签发的 token。
  const verified = await verifyJwt(hint, keySet, {
    expectedIssuer: ctx.issuer,
    allowExpired: true,
  })
  if (!verified.ok) return null
  return verified.value.payload
}

// post_logout_redirect_uri 精确匹配 client 注册列表(否则不回跳,渲染确认)。
function resolveRedirect(
  client: Awaited<ReturnType<typeof findClient>>,
  requested: string | undefined,
): string | null {
  if (!client || !requested) return null
  return client.postLogoutRedirectUris.includes(requested) ? requested : null
}

// 发 back-channel logout_token 到 RP backchannel_logout_uri(签名同 ID token 密钥,含 sid/sub)。
async function sendBackchannelLogout(
  c: Context<XidHonoEnv>,
  input: { client: Awaited<ReturnType<typeof findClient>>; sub?: string; sid?: string },
): Promise<void> {
  const client = input.client
  if (!client?.backchannelLogoutUri) return
  if (!input.sub && !input.sid) return
  const ctx = c.get('tenant')
  const signer = await loadActiveSigner(ctx, c.env.KEK)
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: ctx.issuer,
    aud: client.clientId,
    iat: now,
    exp: now + BACKCHANNEL_LOGOUT_TOKEN_TTL_SEC,
    jti: crypto.randomUUID(),
    events: { [LOGOUT_EVENT]: {} },
  }
  if (input.sub) payload['sub'] = input.sub
  if (input.sid) payload['sid'] = input.sid
  const logoutToken = await signJwt(
    { header: { alg: signer.alg, kid: signer.kid, typ: 'logout+jwt' }, payload },
    signer.privateKey,
  )
  await fetch(client.backchannelLogoutUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ logout_token: logoutToken }).toString(),
  })
}

type HintPayload = Awaited<ReturnType<typeof verifyIdTokenHint>>

// 无有效 id_token_hint 时的登出确认页:GET 直撤是 CSRF logout 面(第三方页可 <img> 触发强制登出),
// OIDC RP-Init 要求无 hint 时先确认。表单 POST confirm=true 才真正撤销;post_logout_redirect_uri /
// client_id / state 经 hidden input 透传,确认后仍能回跳。
function renderLogoutConfirmPage(c: Context<XidHonoEnv>, params: RawParams): Response {
  const hidden = (['post_logout_redirect_uri', 'client_id', 'state'] as const)
    .map((key) => {
      const value = params[key]
      return value === undefined
        ? ''
        : `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`
    })
    .join('')
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Log out - xid</title>',
    '<style>',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#171717;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.card{max-width:26rem;padding:2rem;text-align:center}',
    '.brand{margin:0 0 1.5rem;font-size:.875rem;font-weight:600;color:#737373}',
    'h1{margin:0 0 .75rem;font-size:1.25rem}',
    '.desc{margin:0 0 1.25rem;color:#404040}',
    'button{padding:.5rem 1.25rem;border:0;border-radius:6px;background:#171717;color:#fafafa;font-size:.875rem;cursor:pointer}',
    '</style>',
    '</head>',
    '<body>',
    '<main class="card">',
    '<p class="brand">xid</p>',
    '<h1>Log out</h1>',
    '<p class="desc">Are you sure you want to log out?</p>',
    '<form method="post" action="/end_session">',
    hidden,
    '<input type="hidden" name="confirm" value="true">',
    '<button type="submit">Log out</button>',
    '</form>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
  return c.body(html, 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
  })
}

// 解析目标 client(client_id 参数优先,回退 id_token_hint aud),并发 back-channel logout。
async function resolveLogoutClient(
  c: Context<XidHonoEnv>,
  params: RawParams,
  hint: HintPayload,
): Promise<Awaited<ReturnType<typeof findClient>>> {
  const hintAud = typeof hint?.aud === 'string' ? hint.aud : undefined
  const clientId = params['client_id'] ?? hintAud
  const client = clientId ? await findClient(c, clientId) : null
  if (client) await sendBackchannelLogout(c, { client, sub: hint?.sub, sid: hint?.sid })
  return client
}

async function handleEndSession(c: Context<XidHonoEnv>): Promise<Response> {
  const params = await parseParams(c)
  const hintPayload = await verifyIdTokenHint(c, params['id_token_hint'])

  // 无有效 hint 且未确认 -> 确认页,不撤销(CSRF logout 防护,见 renderLogoutConfirmPage)。
  if (hintPayload === null && (c.req.method !== 'POST' || params['confirm'] !== 'true')) {
    return renderLogoutConfirmPage(c, params)
  }

  const session = await readSession(c)
  if (session) await revokeSession(c, session)

  const client = await resolveLogoutClient(c, params, hintPayload)
  const redirect = resolveRedirect(client, params['post_logout_redirect_uri'])
  if (redirect) {
    const url = new URL(redirect)
    if (params['state']) url.searchParams.set('state', params['state'])
    return c.redirect(url.toString(), 302)
  }
  const frontChannelHtml = buildFrontChannelLogoutPage(c, client, hintPayload)
  if (frontChannelHtml) {
    return c.html(frontChannelHtml, 200, { 'cache-control': 'no-store' })
  }
  return c.json({ logged_out: true }, 200, { 'cache-control': 'no-store' })
}

function buildFrontChannelLogoutUri(
  c: Context<XidHonoEnv>,
  client: NonNullable<Awaited<ReturnType<typeof findClient>>>,
  hint: HintPayload,
): string | null {
  const uri = client.frontchannelLogoutUri
  if (!uri) return null
  const ctx = c.get('tenant')
  const url = new URL(uri)
  url.searchParams.set('iss', ctx.issuer)
  if (hint?.sid) url.searchParams.set('sid', hint.sid)
  if (hint?.sub) url.searchParams.set('sub', hint.sub)
  return url.toString()
}

function buildFrontChannelLogoutPage(
  c: Context<XidHonoEnv>,
  client: Awaited<ReturnType<typeof findClient>>,
  hint: HintPayload,
): string | null {
  if (!client) return null
  const target = buildFrontChannelLogoutUri(c, client, hint)
  if (!target) return null
  const escaped = target.replace(/"/g, '&quot;')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logged out</title></head><body><p>Logged out.</p><iframe src="${escaped}" width="0" height="0" style="display:none"></iframe></body></html>`
}

// 注册 /end_session 路由(GET + POST,OIDC RP-Init Logout)。
export function registerEndSessionRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/end_session', handleEndSession)
  app.post('/end_session', handleEndSession)
}
