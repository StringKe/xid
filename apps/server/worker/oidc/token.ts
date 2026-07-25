// /token 端点(03 章 9):公共前置(方法/Content-Type/client 认证/DPoP 探测/grant 路由)+ 五 grant 分发。
// 成功/错误均 Cache-Control: no-store(RFC6749 5.1)。grant 实现在 token-grants.ts,本层只装配 TokenContext。
// 铁律:client 认证只接受注册的那一种;DPoP 在场写 cnf.jkt;签名密钥从 TenantContext active 取。

import type { Result, XidError } from '@xid-kit/types'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { authenticateClient, parseBasicAuth } from './client-auth'
import type { ClientCredentials } from './client-auth'
import { clientAllowsMtlsTokenBinding, fapiRequiresSenderConstraint } from './client-policy'
import { verifyTokenDpop } from './dpop'
import { readMtlsBinding } from './mtls'
import {
  applyPublicClientCors,
  findClient,
  handlePublicClientOptions,
  loadActiveSigner,
  oauthError,
  parseUniqueForm,
  tokenJson,
} from './shared'
import type { ClientRow } from './shared'
import { grantAuthorizationCode, grantClientCredentials, grantRefreshToken } from './token-grants'
import {
  DEVICE_CODE_GRANT,
  TOKEN_EXCHANGE_GRANT,
  grantDeviceCode,
  grantTokenExchange,
} from './token-exchange'
import { grantCiba, CIBA_GRANT } from './ciba'
import type { TokenContext } from './token-issue'

type RawParams = Record<string, string>
type GrantHandler = (tc: TokenContext) => Promise<Result<Record<string, unknown>, XidError>>

const TOKEN_CORS = {
  methods: ['POST'],
  allowHeaders: 'content-type,dpop',
  exposeHeaders: 'dpop-nonce',
} as const

const SUPPORTED_GRANT_TYPES = [
  'authorization_code',
  'client_credentials',
  'refresh_token',
  DEVICE_CODE_GRANT,
  TOKEN_EXCHANGE_GRANT,
  CIBA_GRANT,
] as const
type GrantType = (typeof SUPPORTED_GRANT_TYPES)[number]

// grant_type 白名单收口到 valibot picklist(类型收窄);未知值仍按 RFC6749 5.2 回
// unsupported_grant_type,错误语义不随 schema 化改变。
const grantTypeSchema = v.picklist(SUPPORTED_GRANT_TYPES)

const GRANT_HANDLERS: Record<GrantType, GrantHandler> = {
  authorization_code: grantAuthorizationCode,
  client_credentials: grantClientCredentials,
  refresh_token: grantRefreshToken,
  [DEVICE_CODE_GRANT]: grantDeviceCode,
  [TOKEN_EXCHANGE_GRANT]: grantTokenExchange,
  [CIBA_GRANT]: grantCiba,
}

function extractCredentials(authHeader: string | undefined, form: RawParams): ClientCredentials {
  return {
    basic: parseBasicAuth(authHeader),
    postClientId: form['client_id'] ?? null,
    postSecret: form['client_secret'] ?? null,
    assertionType: form['client_assertion_type'] ?? null,
    assertion: form['client_assertion'] ?? null,
  }
}

function applyTokenCors(c: Context<XidHonoEnv>, client: ClientRow, response: Response): Response {
  return applyPublicClientCors(c, client, response, TOKEN_CORS)
}

function handleTokenOptions(c: Context<XidHonoEnv>): Promise<Response> {
  return handlePublicClientOptions(c, TOKEN_CORS)
}

// 解析认证后的 client(9.0 第 4 步)。返回 client 行或错误响应。
async function resolveClient(
  c: Context<XidHonoEnv>,
  form: RawParams,
  now: number,
): Promise<{ client: ClientRow; clientId: string } | Response> {
  const ctx = c.get('tenant')
  const creds = extractCredentials(c.req.header('authorization'), form)
  const clientId = creds.basic?.clientId ?? creds.postClientId
  if (!clientId) {
    return oauthError(c, {
      status: 401,
      error: 'invalid_client',
      description: 'client authentication required',
    })
  }
  const client = await findClient(c, clientId)
  if (!client) {
    // RFC6749 5.2:经 Authorization header 认证失败的 401 必须带 WWW-Authenticate 挑战。
    const extra = creds.basic
      ? { 'www-authenticate': 'Basic realm="xid", error="invalid_client"' }
      : undefined
    return oauthError(c, {
      status: 401,
      error: 'invalid_client',
      description: 'unknown client',
      ...(extra ? { extraHeaders: extra } : {}),
    })
  }

  const auth = await authenticateClient({
    c,
    client,
    creds,
    ctx,
    tokenEndpoint: `${ctx.issuer}/token`,
    now,
  })
  if (!auth.ok) {
    const extra =
      auth.error.meta?.paramName === 'Basic' ? { 'www-authenticate': 'Basic' } : undefined
    return oauthError(c, {
      status: auth.error.httpStatus,
      error: auth.error.code,
      description: auth.error.message,
      ...(extra ? { extraHeaders: extra } : {}),
    })
  }
  return { client, clientId: auth.clientId }
}

// DPoP 探测(9.0 第 6 步):带 DPoP header 则校验产出 jkt;client 要求绑定但缺失 -> invalid_dpop_proof。
async function resolveDpop(
  c: Context<XidHonoEnv>,
  client: ClientRow,
): Promise<{ jkt: string | null } | Response> {
  const proof = c.req.header('dpop')
  if (!proof) {
    if (client.dpopBoundAccessTokens) {
      return oauthError(c, {
        status: 400,
        error: 'invalid_dpop_proof',
        description: 'client requires DPoP-bound tokens',
      })
    }
    return { jkt: null }
  }
  const verified = await verifyTokenDpop(c, proof)
  if (!verified.ok) {
    const extra =
      verified.error.code === 'use_dpop_nonce' ? { 'dpop-nonce': crypto.randomUUID() } : undefined
    return oauthError(c, {
      status: verified.error.httpStatus,
      error: verified.error.code,
      description: verified.error.message,
      ...(extra ? { extraHeaders: extra } : {}),
    })
  }
  return { jkt: verified.value.jkt }
}

// grant_type 路由 + 白名单校验(9.0 第 5 步)。
function resolveGrantHandler(
  c: Context<XidHonoEnv>,
  client: ClientRow,
  grantType: string | undefined,
): GrantHandler | Response {
  if (!grantType) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_request',
      description: 'grant_type is required',
    })
  }
  const parsed = v.safeParse(grantTypeSchema, grantType)
  if (!parsed.success) {
    return oauthError(c, {
      status: 400,
      error: 'unsupported_grant_type',
      description: `unknown grant_type ${grantType}`,
    })
  }
  if (!client.allowedGrantTypes.includes(parsed.output)) {
    return oauthError(c, {
      status: 400,
      error: 'unauthorized_client',
      description: 'grant_type not allowed for this client',
    })
  }
  return GRANT_HANDLERS[parsed.output]
}

async function handleToken(c: Context<XidHonoEnv>): Promise<Response> {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_request',
      description: 'Content-Type must be x-www-form-urlencoded',
    })
  }
  const form = await parseUniqueForm(c)
  if (form instanceof Response) return form
  const now = Math.floor(Date.now() / 1000)

  const clientResult = await resolveClient(c, form, now)
  if (clientResult instanceof Response) return clientResult
  const { client, clientId } = clientResult

  const handler = resolveGrantHandler(c, client, form['grant_type'])
  if (handler instanceof Response) return applyTokenCors(c, client, handler)

  const dpop = await resolveDpop(c, client)
  if (dpop instanceof Response) return applyTokenCors(c, client, dpop)

  const mtlsBinding = clientAllowsMtlsTokenBinding(client) ? readMtlsBinding(c, client) : null

  const signer = await loadActiveSigner(c.get('tenant'), c.env.KEK)
  const tc: TokenContext = {
    c,
    signer,
    client,
    clientId,
    dpopJkt: dpop.jkt,
    mtlsCertThumbprint: mtlsBinding?.certThumbprint ?? null,
    form,
    now,
  }
  if (fapiRequiresSenderConstraint(tc)) {
    return applyTokenCors(
      c,
      client,
      oauthError(c, {
        status: 400,
        error: 'invalid_request',
        description: 'FAPI client requires DPoP or mTLS sender constraint',
      }),
    )
  }
  const result = await handler(tc)
  if (!result.ok) {
    return applyTokenCors(
      c,
      client,
      oauthError(c, {
        status: result.error.httpStatus,
        error: result.error.code,
        description: result.error.message,
      }),
    )
  }
  return applyTokenCors(c, client, tokenJson(c, result.value))
}

// 注册 /token 路由(wire 阶段统一挂载)。非 POST 由 Hono 405。
export function registerTokenRoutes(app: Hono<XidHonoEnv>): void {
  app.options('/token', handleTokenOptions)
  app.post('/token', handleToken)
}
