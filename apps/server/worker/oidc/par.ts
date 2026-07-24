// /par 端点(RFC9126、03 章 10.3):POST 校验 client 认证后把全部 authorization 参数存 ParStore DO,
// 返回 request_uri(60s 一次性);/authorize 带 request_uri 时 resolvePar 取出参数替换 query。
// 铁律:client 认证复用 client-auth;DO name=tenantId,request_uri 不可信不可重定向(错误本地渲染)。

import { base64UrlEncode } from '@xid-kit/crypto'
import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { authenticateClient, parseBasicAuth } from './client-auth'
import type { ClientCredentials } from './client-auth'
import { findClient, oauthError, parseUniqueForm } from './shared'
import { resolveRequestObject } from './request-object'
import { parseAuthorizationDetails } from './authorization-details'
import { PAR_TTL_SEC } from '../lib/ttl'

const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:'
const OPAQUE_BYTES = 32

type RawParams = Record<string, string>

function parStub(c: Context<XidHonoEnv>): DurableObjectStub {
  const ctx = c.get('tenant')
  const ns = c.env.PAR_STORE
  return ns.get(ns.idFromName(ctx.tenantId))
}

// 从 token endpoint 风格的凭证抽取(PAR 客户端认证同 /token 9.6)。
function extractCredentials(authHeader: string | undefined, form: RawParams): ClientCredentials {
  return {
    basic: parseBasicAuth(authHeader),
    postClientId: form['client_id'] ?? null,
    postSecret: form['client_secret'] ?? null,
    assertionType: form['client_assertion_type'] ?? null,
    assertion: form['client_assertion'] ?? null,
  }
}

// POST /par:认证 client -> 存参数 -> 返回 { request_uri, expires_in }。
async function handlePar(c: Context<XidHonoEnv>): Promise<Response> {
  const ctx = c.get('tenant')
  const form = await parseUniqueForm(c)
  if (form instanceof Response) return form
  const clientId = form['client_id'] ?? parseBasicAuth(c.req.header('authorization'))?.clientId
  if (!clientId) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_request',
      description: 'client_id is required',
    })
  }

  const client = await findClient(c, clientId)
  if (!client) {
    return oauthError(c, { status: 401, error: 'invalid_client', description: 'unknown client' })
  }

  const creds = extractCredentials(c.req.header('authorization'), form)
  const auth = await authenticateClient({
    c,
    client,
    creds,
    ctx,
    tokenEndpoint: `${ctx.issuer}/par`,
    now: Math.floor(Date.now() / 1000),
  })
  if (!auth.ok) {
    return oauthError(c, {
      status: auth.error.httpStatus,
      error: auth.error.code,
      description: auth.error.message,
    })
  }

  const requestObject = await resolveRequestObject({
    c,
    params: form,
    client,
    now: Math.floor(Date.now() / 1000),
  })
  if (!requestObject.ok) {
    return oauthError(c, {
      status: 400,
      error: requestObject.error,
      description: requestObject.description,
    })
  }
  const authorizationDetails = await parseAuthorizationDetails(
    c,
    requestObject.params['authorization_details'],
  )
  if (!authorizationDetails.ok) {
    return oauthError(c, {
      status: authorizationDetails.error.httpStatus,
      error: authorizationDetails.error.code,
      description: authorizationDetails.error.message,
    })
  }

  const requestUri = `${REQUEST_URI_PREFIX}${base64UrlEncode(crypto.getRandomValues(new Uint8Array(OPAQUE_BYTES)))}`
  const ok = await storeParRequest(c, requestUri, requestObject.params)
  if (!ok) {
    return oauthError(c, {
      status: 500,
      error: 'server_error',
      description: 'failed to store PAR request',
    })
  }

  return c.json({ request_uri: requestUri, expires_in: PAR_TTL_SEC }, 201, {
    'cache-control': 'no-store',
    pragma: 'no-cache',
  })
}

// 把 authorization 参数(剔除密钥类字段)写入 ParStore DO,60s 一次性。
async function storeParRequest(
  c: Context<XidHonoEnv>,
  requestUri: string,
  form: RawParams,
): Promise<boolean> {
  const stored: RawParams = { ...form }
  delete stored['client_secret']
  delete stored['client_assertion']
  const res = await parStub(c).fetch('https://par-store/store', {
    method: 'POST',
    body: JSON.stringify({
      requestUri,
      params: stored,
      expiresAt: Date.now() + PAR_TTL_SEC * 1000,
    }),
  })
  return res.ok
}

function isRawParams(value: unknown): value is RawParams {
  if (!value || typeof value !== 'object') return false
  return Object.values(value).every((item) => typeof item === 'string')
}

// PAR 存的一律是平铺 form 参数(全字符串)。坏 body 若被当成空参数放行,client_id 一致性校验
// (body.params['client_id'] === undefined)会因为 query 无 client_id 而形同虚设,
// 后续 redirect_uri / PKCE 也全部取到 undefined -> 降级成无约束的 authorize 请求。
async function parseConsumedPar(res: Response): Promise<RawParams | null> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const params = (body as Record<string, unknown>)['params']
  if (!isRawParams(params)) return null
  return params
}

export type ResolvedPar =
  | { ok: true; params: RawParams }
  | { ok: false; status: 400 | 500; error: string; description: string }

// ParStore 的错误体是 { error, error_description }(见 durable-objects/par-store.ts jsonError)。
async function readParErrorCode(res: Response): Promise<string | null> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const code = (body as Record<string, unknown>)['error']
  return typeof code === 'string' ? code : null
}

// consume 的正常否定结论只有两个(par-store.ts handleConsume):404 request_uri 不存在/已消费,
// 400 + error=expired_token 已过期。这两个是 RP 的问题,回 400 invalid_request。
// 其余(DO 5xx、405 method_not_allowed、我们自己发坏 body 的 400 invalid_request)是服务端故障:
// 并进 400 会让 RP 认定自己参数错而不重试,运维侧也看不到 5xx。
// 404 不再细分 error code:consume 路径在本文件是硬编码字面量,取不到 not_found 那条分支。
async function classifyParConsumeFailure(res: Response): Promise<ResolvedPar> {
  const rejected =
    res.status === 404 || (res.status === 400 && (await readParErrorCode(res)) === 'expired_token')
  if (rejected) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      description: 'request_uri invalid or expired',
    }
  }
  return {
    ok: false,
    status: 500,
    error: 'server_error',
    description: 'request_uri storage is unavailable',
  }
}

// /authorize 的 PAR 替换(10.3):若带 request_uri 则消费 DO 取出参数,校验 client_id 一致。
export async function resolvePar(c: Context<XidHonoEnv>, query: RawParams): Promise<ResolvedPar> {
  const requestUri = query['request_uri']
  if (!requestUri) return { ok: true, params: query }
  if (!requestUri.startsWith(REQUEST_URI_PREFIX)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      description: 'malformed request_uri',
    }
  }
  const res = await parStub(c).fetch('https://par-store/consume', {
    method: 'POST',
    body: JSON.stringify({ requestUri }),
  })
  if (!res.ok) return classifyParConsumeFailure(res)
  const params = await parseConsumedPar(res)
  if (!params) {
    return {
      ok: false,
      status: 500,
      error: 'server_error',
      description: 'request_uri storage returned malformed response',
    }
  }
  // request_uri 内 client_id 必须与 query client_id 一致(10.3)。
  if (query['client_id'] && params['client_id'] !== query['client_id']) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      description: 'client_id mismatch with request_uri',
    }
  }
  return { ok: true, params }
}

// 注册 /par 路由(wire 阶段统一挂载)。
export function registerParRoutes(app: Hono<XidHonoEnv>): void {
  app.post('/par', handlePar)
}

export { REQUEST_URI_PREFIX }
