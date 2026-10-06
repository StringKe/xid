// /end_session 端点(03 章 7、OIDC RP-Initiated Logout):验证 id_token_hint,撤销 session,
// 校验 post_logout_redirect_uri 后回跳;对绑定 RP 发 back-channel logout_token(首选,更可靠)。
// 铁律:id_token_hint 验签用 TenantContext 公钥集;redirect 精确匹配注册的 post_logout_redirect_uris。

import { signJwt, verifyJwt } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import { readSession, revokeSession } from '../lib/session'
import { AppError } from '../lib/errors'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { isPublicHttpsUrl, isValidPostLogoutRedirectUri } from '../lib/validate'
import { buildVerifyKeySet, findClient, loadActiveSigner } from './shared'
import { BACKCHANNEL_LOGOUT_TOKEN_TTL_SEC } from '../lib/ttl'
import { renderLogoutConfirmPage, renderSignedOutPage } from './logout-pages'

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'
const BACKCHANNEL_LOGOUT_TIMEOUT_MS = 5_000
const SESSION_CLIENT_LOOKUP_LIMIT = 100

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
  return client.postLogoutRedirectUris.includes(requested) &&
    isValidPostLogoutRedirectUri(requested)
    ? requested
    : null
}

// 发 back-channel logout_token 到 RP backchannel_logout_uri(签名同 ID token 密钥,含 sid/sub)。
async function sendBackchannelLogout(
  c: Context<XidHonoEnv>,
  input: { client: Awaited<ReturnType<typeof findClient>>; sub?: string; sid?: string },
): Promise<void> {
  const client = input.client
  if (!client?.backchannelLogoutUri) return
  if (!isPublicHttpsUrl(client.backchannelLogoutUri)) return
  const backchannelUrl = new URL(client.backchannelLogoutUri)
  if (backchannelUrl.username || backchannelUrl.password || backchannelUrl.hash) return
  if (!input.sub && !input.sid) return
  try {
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
    const response = await fetch(client.backchannelLogoutUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: logoutToken }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(BACKCHANNEL_LOGOUT_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`back-channel logout returned ${response.status}`)
  } catch (error) {
    try {
      await c.env.AUDIT_QUEUE.send({
        tenantId: c.get('tenant').tenantId,
        action: 'oidc.backchannel_logout_failed',
        ts: Date.now(),
        payload: {
          targetType: 'application',
          targetId: client.clientId,
        },
      })
    } catch (auditError) {
      logWorkerError('oidc.backchannel_logout.audit_failed', auditError, {
        component: 'oidc',
        operation: 'backchannel_logout',
      })
    }
    logWorkerError('oidc.backchannel_logout.delivery_failed', error, {
      component: 'oidc',
      operation: 'backchannel_logout',
    })
  }
}

async function scheduleBackchannelLogout(
  c: Context<XidHonoEnv>,
  input: Parameters<typeof sendBackchannelLogout>[1],
): Promise<void> {
  const task = sendBackchannelLogout(c, input)
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    await task
  }
}

type HintPayload = Awaited<ReturnType<typeof verifyIdTokenHint>>
type LogoutClient = NonNullable<Awaited<ReturnType<typeof findClient>>>

// 解析发起登出的 client(client_id 参数优先,回退 id_token_hint aud)。
async function resolveLogoutClient(
  c: Context<XidHonoEnv>,
  params: RawParams,
  hint: HintPayload,
): Promise<Awaited<ReturnType<typeof findClient>>> {
  const audiences =
    typeof hint?.aud === 'string'
      ? [hint.aud]
      : Array.isArray(hint?.aud)
        ? hint.aud.filter((value): value is string => typeof value === 'string')
        : []
  const explicitClientId = params['client_id']
  if (explicitClientId && hint && !audiences.includes(explicitClientId)) {
    throw new AppError('invalid_request', {
      httpStatus: 400,
      longMessage: 'client_id does not match id_token_hint audience',
    })
  }
  const candidates = explicitClientId ? [explicitClientId] : audiences
  for (const clientId of candidates) {
    const client = await findClient(c, clientId)
    if (client) return client
  }
  return null
}

// 同一 session 签发过授权码或 refresh token 的其他 client 也要收到登出通知。
// 授权码过期后由 hourly cron 删除,所以只覆盖仍持有该 session refresh token 或近期取得授权码的 RP。
async function sessionClients(
  c: Context<XidHonoEnv>,
  sessionId: string | undefined,
): Promise<LogoutClient[]> {
  if (!sessionId) return []
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [codes, refreshTokens] = await Promise.all([
    db.authorizationCodes.findMany(eq(schema.authorizationCodes.sessionId, sessionId), {
      limit: SESSION_CLIENT_LOOKUP_LIMIT,
    }),
    db.refreshTokens.findMany(eq(schema.refreshTokens.sessionId, sessionId), {
      limit: SESSION_CLIENT_LOOKUP_LIMIT,
    }),
  ])
  const clientIds = new Set([...codes, ...refreshTokens].map((row) => row.clientId))
  const clients = await Promise.all([...clientIds].map((clientId) => findClient(c, clientId)))
  return clients.filter((client): client is LogoutClient => client !== null)
}

function uniqueClients(clients: readonly (LogoutClient | null)[]): LogoutClient[] {
  const byId = new Map<string, LogoutClient>()
  for (const client of clients) {
    if (client && !byId.has(client.clientId)) byId.set(client.clientId, client)
  }
  return [...byId.values()]
}

function frontChannelLogoutUri(
  c: Context<XidHonoEnv>,
  client: LogoutClient,
  subject: { sub?: string; sid?: string },
): string | null {
  const uri = client.frontchannelLogoutUri
  if (!uri) return null
  const url = new URL(uri)
  url.searchParams.set('iss', c.get('tenant').issuer)
  if (subject.sid) url.searchParams.set('sid', subject.sid)
  if (subject.sub) url.searchParams.set('sub', subject.sub)
  return url.toString()
}

async function handleEndSession(c: Context<XidHonoEnv>): Promise<Response> {
  const params = await parseParams(c)
  const hintPayload = await verifyIdTokenHint(c, params['id_token_hint'])

  // 无有效 hint 且未确认 -> 确认页,不撤销(CSRF logout 防护,见 renderLogoutConfirmPage)。
  if (hintPayload === null && (c.req.method !== 'POST' || params['confirm'] !== 'true')) {
    return renderLogoutConfirmPage(c, params)
  }

  const initiator = await resolveLogoutClient(c, params, hintPayload)
  const session = await readSession(c)
  const subject = {
    sub: hintPayload?.sub ?? session?.userId,
    sid: hintPayload?.sid ?? session?.sessionId,
  }
  const clients = uniqueClients([initiator, ...(await sessionClients(c, subject.sid))])
  if (session) await revokeSession(c, session)
  await Promise.all(clients.map((client) => scheduleBackchannelLogout(c, { client, ...subject })))

  const redirect = resolveRedirect(initiator, params['post_logout_redirect_uri'])
  const continueUrl = redirect ? withState(redirect, params['state']) : null
  const frontChannelUris = clients
    .map((client) => frontChannelLogoutUri(c, client, subject))
    .filter((uri): uri is string => uri !== null)
  if (continueUrl && frontChannelUris.length === 0) return c.redirect(continueUrl, 302)
  return renderSignedOutPage(c, { frontChannelUris, continueUrl })
}

function withState(redirect: string, state: string | undefined): string {
  const url = new URL(redirect)
  if (state) url.searchParams.set('state', state)
  return url.toString()
}

// 注册 /end_session 路由(GET + POST,OIDC RP-Init Logout)。
export function registerEndSessionRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/end_session', handleEndSession)
  app.post('/end_session', handleEndSession)
}
