// OIDC/OAuth endpoint 共享辅助:client 查询 / KEK 解码 / active 签名密钥载入 /
// JWKS 校验密钥集 / OAuth 错误响应。endpoint 复用本层,避免重复 wire D1/crypto。
// 铁律:issuer/签名密钥/rpId 从 TenantContext(c.get('tenant'))取,禁模块级常量持有租户敏感值。

import { importJwkForVerify, loadSigningKey } from '@xid-kit/crypto'
import type { VerifyKeySet } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { DEFAULT_TOKEN_POLICY } from '@xid-kit/types'
import type { SigningAlg, TenantContext, TokenPolicy } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { BaseIssue } from 'valibot'
import { firstIssuePath } from '../lib/validate'
import type { XidHonoEnv } from '../lib/types'
import { storedClientPolicy, validateClientRegistrationPolicy } from './client-registration-policy'

// applications 行 = OAuthClient 注册元数据(08 章 10.4)。
export type ClientRow = typeof schema.applications.$inferSelect

// active 签名密钥句柄:不可导出私钥 + kid + alg(签发 token / id_token 用)。
export type ActiveSigner = {
  kid: string
  alg: SigningAlg
  privateKey: CryptoKey
}

const SEC_PER_DAY = 24 * 60 * 60

// 租户 token TTL 策略:buildPolicy 恒输出 normalize 结果(见 @xid-kit/db tenant-context),
// 类型可选仅兜底手写 TenantContext(如测试),回退内置默认保持签发链路不空指针。
export function tokenPolicyOf(ctx: TenantContext): TokenPolicy {
  return ctx.policy.token ?? DEFAULT_TOKEN_POLICY
}

// access token TTL 三层解析:client 覆盖 > 租户 token 策略 > 内置默认(03 章 Token 生命周期)。
export function resolveAccessTtlSec(ctx: TenantContext, clientTtlSec: number | null): number {
  return clientTtlSec ?? tokenPolicyOf(ctx).accessTokenTtlSec
}

// refresh token TTL(秒):策略按天存储,protocol 层按秒计算,换算统一收口在此。
export function refreshTtlSecOf(ctx: TenantContext): {
  idleTtlSec: number
  absoluteTtlSec: number
} {
  const policy = tokenPolicyOf(ctx)
  return {
    idleTtlSec: policy.refreshIdleTimeoutDays * SEC_PER_DAY,
    absoluteTtlSec: policy.refreshAbsoluteTimeoutDays * SEC_PER_DAY,
  }
}

// env.KEK 是 base64 标准编码的 32 字节;每次解码避免模块级常量持有密钥(见 tenant-context rule)。
export function decodeKek(kekB64: string): Uint8Array {
  const binary = atob(kekB64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// 按 client_id 查 application(租户隔离:走租户查询层自动注入 tenant_id)。Project-linked
// client 还要求所属 Project active，这一共享边界覆盖 authorize/token/userinfo/CIBA 等所有
// 调用方，避免 Project 软删除后 refresh/client_credentials 继续签发。
export async function findClient(
  c: Context<XidHonoEnv>,
  clientId: string,
): Promise<ClientRow | null> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const row = await db.applications.findOne(
    and(eq(schema.applications.clientId, clientId), eq(schema.applications.status, 'active')),
  )
  if (!row) return null
  if (validateClientRegistrationPolicy(storedClientPolicy(row))) return null
  if (row.projectId !== null) {
    const project = await db.projects.findOne(
      and(eq(schema.projects.id, row.projectId), eq(schema.projects.status, 'active')),
    )
    if (!project) return null
  }
  return row
}

// 从 TenantContext active 密钥集载入签名私钥(信封解密 -> 不可导出 importKey,见 signing-keys rule)。
export async function loadActiveSigner(ctx: TenantContext, kekB64: string): Promise<ActiveSigner> {
  const kid = ctx.signingKeys.activeKid
  const material = ctx.signingKeys.keys.find((k) => k.kid === kid)
  if (!material) {
    throw new Error('active signing key material not found in TenantContext')
  }
  const privateKey = await loadSigningKey(material.encryptedPrivateKey, decodeKek(kekB64))
  return { kid, alg: material.alg, privateKey }
}

// 把 TenantContext 公钥集导入为 VerifyKeySet(校验本 issuer 签发的 token,如 token-exchange / end_session)。
export async function buildVerifyKeySet(ctx: TenantContext): Promise<VerifyKeySet> {
  const keys = await Promise.all(
    ctx.signingKeys.keys.map(async (m) => ({
      kid: m.kid,
      alg: m.alg,
      publicKey: await importJwkForVerify({
        ...m.publicKeyJwk,
        kid: m.kid,
        use: 'sig' as const,
        alg: m.alg,
      }),
    })),
  )
  return { keys }
}

// RFC7662/7009/8628:client 认证失败的 401 必须带 WWW-Authenticate(RFC6749 5.2),
// realm/error 参数让 client 可区分"凭证缺失"与"凭证错误"。
export const BASIC_AUTH_CHALLENGE = 'Basic realm="xid", error="invalid_client"'

// RFC6749 5.2 错误体 { error, error_description }。token/par 端点统一 no-store。
export type OAuthErrorBody = {
  error: string
  error_description?: string
  error_uri?: string
}

// OAuth 错误参数(附加头如 WWW-Authenticate/DPoP-Nonce 由调用方传入)。
export type OAuthErrorInput = {
  status: number
  error: string
  description: string
  extraHeaders?: Record<string, string>
}

// 构造 OAuth 错误 JSON(token/par/device 端点用),统一 no-store。
export function oauthError(c: Context<XidHonoEnv>, input: OAuthErrorInput): Response {
  const body: OAuthErrorBody = { error: input.error, error_description: input.description }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    ...input.extraHeaders,
  }
  return c.body(JSON.stringify(body), input.status as 400, headers)
}

// 成功 token 响应(no-store)。body 已是组装好的对象。
export function tokenJson(c: Context<XidHonoEnv>, body: Record<string, unknown>): Response {
  return c.body(JSON.stringify(body), 200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    pragma: 'no-cache',
  })
}

// RFC6749 3.1:同名参数重复出现必须 invalid_request;form 值只接受 string(File 视为畸形输入)。
// token/par/ciba 三个 form 端点统一收口于此。
export async function parseUniqueForm(
  c: Context<XidHonoEnv>,
): Promise<Record<string, string> | Response> {
  const form = await c.req.raw.clone().formData()
  const out: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (key in out) {
      return oauthError(c, {
        status: 400,
        error: 'invalid_request',
        description: `duplicate parameter ${key}`,
      })
    }
    if (typeof value !== 'string') {
      return oauthError(c, {
        status: 400,
        error: 'invalid_request',
        description: `parameter ${key} must be a string`,
      })
    }
    out[key] = value
  }
  return out
}

// valibot 形状失败 -> RFC6749 invalid_request(dot path 指明首个问题参数)。
// 协议端点错误直接 return Response(不经 onError、不带 meta、不走 i18n),与 AppError 路径刻意分开。
export function oauthInvalidRequest(
  c: Context<XidHonoEnv>,
  issues: readonly [BaseIssue<unknown>, ...BaseIssue<unknown>[]],
): Response {
  return oauthError(c, {
    status: 400,
    error: 'invalid_request',
    description: `Missing or invalid parameter: ${firstIssuePath(issues)}`,
  })
}

// scope 白名单:请求 scope 必须 ⊆ client.allowedScopes(device / ciba 共用,对齐 RFC8628 3.5 invalid_scope)。
// 返回首个越权 scope;全在白名单内返回 null。
export function findDisallowedScope(
  allowedScopes: readonly string[],
  requestedScopes: readonly string[],
): string | null {
  const allowed = new Set(allowedScopes)
  return requestedScopes.find((s) => !allowed.has(s)) ?? null
}

// 端点绝对 URL(htu / discovery 端点;issuer 来自 TenantContext,见 tenant-context rule)。
export function endpointUrl(ctx: TenantContext, path: string): string {
  return `${ctx.issuer}${path}`
}

// ---- 浏览器跨域 CORS(public client 直调协议端点:token / userinfo)----
// origin 白名单 = client 注册 redirectUris 的 origin 集;confidential client 走服务端,不放行。

export type PublicClientCorsOptions = {
  methods: readonly string[]
  allowHeaders: string
  exposeHeaders?: string
}

export function allowedPublicClientOrigin(
  client: ClientRow,
  origin: string | undefined,
): string | null {
  if (!origin || client.clientType !== 'public') return null
  for (const redirectUri of client.redirectUris) {
    try {
      if (new URL(redirectUri).origin === origin) return origin
    } catch {
      continue
    }
  }
  return null
}

function appendVary(current: string | null, value: string): string {
  if (!current) return value
  const items = current.split(',').map((item) => item.trim().toLowerCase())
  return items.includes(value.toLowerCase()) ? current : `${current}, ${value}`
}

// 响应挂 CORS 头(实际请求):origin 不在白名单则原样返回,不额外拒绝(非浏览器调用无 origin)。
export function applyPublicClientCors(
  c: Context<XidHonoEnv>,
  client: ClientRow,
  response: Response,
  opts: PublicClientCorsOptions,
): Response {
  const origin = allowedPublicClientOrigin(client, c.req.header('origin'))
  if (!origin) return response
  response.headers.set('access-control-allow-origin', origin)
  response.headers.set('access-control-allow-methods', opts.methods.join(', '))
  response.headers.set('access-control-allow-headers', opts.allowHeaders)
  if (opts.exposeHeaders) {
    response.headers.set('access-control-expose-headers', opts.exposeHeaders)
  }
  response.headers.set('vary', appendVary(response.headers.get('vary'), 'Origin'))
  return response
}

// OPTIONS 预检:按 query client_id 查 client 白名单(预检无 body,client 只能走 query)。
// origin 不在该 client 注册的 redirectUris origin 集、client 不存在或非 public -> 204 不回 ACAO,
// 浏览器据此拦下实际请求,任意 origin 无法蹭预检通过。
export async function handlePublicClientOptions(
  c: Context<XidHonoEnv>,
  opts: PublicClientCorsOptions,
): Promise<Response> {
  const origin = c.req.header('origin')
  const requestedMethod = c.req.header('access-control-request-method')?.toUpperCase()
  if (!origin || !requestedMethod || !opts.methods.includes(requestedMethod)) {
    return c.body(null, 204)
  }
  const clientId = c.req.query('client_id')
  const client = clientId ? await findClient(c, clientId) : null
  const allowedOrigin = client ? allowedPublicClientOrigin(client, origin) : null
  if (!allowedOrigin) return c.body(null, 204)
  return c.body(null, 204, {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': opts.methods.join(', '),
    'access-control-allow-headers': opts.allowHeaders,
    'access-control-max-age': '600',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  })
}
