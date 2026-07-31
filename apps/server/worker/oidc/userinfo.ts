// /userinfo 端点(03 章 1、OIDC Core 5.3):Bearer/DPoP access token -> 用户 claims。
// Accept 协商:application/jwt -> 签名 JWT;否则 JSON。DPoP token 校验 ath 绑定 + cnf.jkt 一致。
// 铁律:用户查询走租户查询层(自动注入 tenant_id);签名密钥从 TenantContext active 取。

import { signJwt, verifyJwt } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { parseScopeSet } from '@xid-kit/protocol'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { verifyResourceDpop } from './dpop'
import {
  applyPublicClientCors,
  buildVerifyKeySet,
  endpointUrl,
  findClient,
  handlePublicClientOptions,
  loadActiveSigner,
} from './shared'

// public SPA 直调 userinfo 的跨域白名单(token.ts 同套 helper);allow-headers 含 authorization。
const USERINFO_CORS = {
  methods: ['GET', 'POST'],
  allowHeaders: 'authorization,content-type,dpop',
} as const

type UserRow = typeof schema.users.$inferSelect

// 401 + WWW-Authenticate(scheme 按 token 类型;OIDC Core 5.3.3 / RFC6750)。
function unauthorized(
  c: Context<XidHonoEnv>,
  scheme: 'Bearer' | 'DPoP',
  description: string,
): Response {
  return c.body(JSON.stringify({ error: 'invalid_token', error_description: description }), 401, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'www-authenticate': `${scheme} error="invalid_token"`,
  })
}

// 提取 Authorization 头里的 token 与 scheme(Bearer / DPoP)。
function extractBearer(
  header: string | undefined,
): { scheme: 'Bearer' | 'DPoP'; token: string } | null {
  if (!header) return null
  if (header.startsWith('Bearer ')) return { scheme: 'Bearer', token: header.slice(7).trim() }
  if (header.startsWith('DPoP ')) return { scheme: 'DPoP', token: header.slice(5).trim() }
  return null
}

function isAccessTokenJwtTyp(typ: string | undefined): boolean {
  return typ === 'at+jwt' || typ === 'application/at+jwt'
}

// profile scope 的用户属性映射(OIDC Core 5.4 standard claims),仅写非空值。
function profileClaims(user: UserRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const mapping: [keyof UserRow, string][] = [
    ['displayName', 'name'],
    ['firstName', 'given_name'],
    ['lastName', 'family_name'],
    ['username', 'preferred_username'],
    ['avatarUrl', 'picture'],
    ['locale', 'locale'],
    ['timezone', 'zoneinfo'],
  ]
  for (const [field, claim] of mapping) {
    const value = user[field]
    if (value) out[claim] = value
  }
  return out
}

// 联系方式投影(email/phone 主记录),scope 控制是否输出。
type ContactClaims = {
  email: string | null
  emailVerified: boolean
  phone: string | null
  phoneVerified: boolean
}

// scope 控制的 claims 投影(OIDC Core 5.4)。sub 必返回。
function projectClaims(
  user: UserRow,
  scope: string,
  contact: ContactClaims,
): Record<string, unknown> {
  const scopes = parseScopeSet(scope)
  const claims: Record<string, unknown> = { sub: user.id }
  if (scopes.has('profile')) Object.assign(claims, profileClaims(user))
  if (scopes.has('email') && contact.email) {
    claims['email'] = contact.email
    claims['email_verified'] = contact.emailVerified
  }
  if (scopes.has('phone') && contact.phone) {
    claims['phone_number'] = contact.phone
    claims['phone_number_verified'] = contact.phoneVerified
  }
  return claims
}

// 查用户 + 主邮箱 + 主手机(租户查询层)。
async function loadUser(
  c: Context<XidHonoEnv>,
  userId: string,
): Promise<({ user: UserRow } & ContactClaims) | null> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) return null
  let email: string | null = null
  let emailVerified = false
  if (user.primaryEmailId) {
    const row = await db.userEmails.findOne(eq(schema.userEmails.id, user.primaryEmailId))
    if (row) {
      email = row.email
      emailVerified = row.verified
    }
  }
  let phone: string | null = null
  let phoneVerified = false
  if (user.primaryPhoneId) {
    const row = await db.userPhones.findOne(eq(schema.userPhones.id, user.primaryPhoneId))
    if (row) {
      phone = row.phone
      phoneVerified = row.verified
    }
  }
  return { user, email, emailVerified, phone, phoneVerified }
}

async function isAccessTokenRevoked(c: Context<XidHonoEnv>, jti: unknown): Promise<boolean> {
  if (typeof jti !== 'string') return true
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const row = await db.accessTokenRevocations.findOne(eq(schema.accessTokenRevocations.jti, jti))
  return row !== undefined
}

// DPoP token 的资源端点绑定校验(ath + cnf.jkt)。返回错误响应或 null(通过)。
async function checkDpopBinding(
  c: Context<XidHonoEnv>,
  input: { scheme: 'Bearer' | 'DPoP'; token: string; cnf: { jkt?: string } | undefined },
): Promise<Response | null> {
  const proof = c.req.header('dpop')
  const boundJkt = input.cnf?.jkt
  if (boundJkt) {
    if (input.scheme !== 'DPoP' || !proof) {
      return unauthorized(c, 'DPoP', 'DPoP proof required for sender-constrained token')
    }
    const ctx = c.get('tenant')
    const result = await verifyResourceDpop(c, {
      proof,
      htu: endpointUrl(ctx, '/userinfo'),
      accessToken: input.token,
      boundJkt,
    })
    if (!result.ok) return unauthorized(c, 'DPoP', result.error.message)
  }
  return null
}

async function handleUserinfo(c: Context<XidHonoEnv>): Promise<Response> {
  const ctx = c.get('tenant')
  const bearer = extractBearer(c.req.header('authorization'))
  if (!bearer) return unauthorized(c, 'Bearer', 'missing access token')

  const keySet = await buildVerifyKeySet(ctx)
  const verified = await verifyJwt(bearer.token, keySet, {
    expectedIssuer: ctx.issuer,
  })
  if (!verified.ok) return unauthorized(c, bearer.scheme, 'access token verification failed')
  if (!isAccessTokenJwtTyp(verified.value.header.typ)) {
    return unauthorized(c, bearer.scheme, 'access token typ mismatch')
  }

  const payload = verified.value.payload
  // 租户绑定:instance 签名密钥全租户共享,验签通过不代表属于本租户。
  // tenant_id 在场且不等 -> 401 invalid_token;无此 claim 的旧 token 按原路径放行(存量兼容)。
  const tokenTenantId = payload['tenant_id']
  if (typeof tokenTenantId === 'string' && tokenTenantId !== ctx.tenantId) {
    return unauthorized(c, bearer.scheme, 'access token tenant mismatch')
  }
  // aud 必须含 issuer(第一方 session token,见 /v1/sessions/token)、自身 client_id(第三方
  // access token,aud=client_id)或本租户已注册 resource server 的 audience(RFC8707);
  // 其余 aud 说明 token 不是颁给本 IdP 体系的。
  const aud = payload.aud
  const audList = Array.isArray(aud) ? aud : typeof aud === 'string' ? [aud] : []
  const audClientId = typeof payload['client_id'] === 'string' ? payload['client_id'] : null
  let audOk =
    audList.includes(ctx.issuer) || (audClientId !== null && audList.includes(audClientId))
  if (!audOk && audList.length > 0) {
    const db = createTenantDb(c.env.DB, ctx)
    for (const candidate of audList) {
      const resource = await db.resourceServers.findOne(
        eq(schema.resourceServers.audience, candidate),
      )
      if (resource) {
        audOk = true
        break
      }
    }
  }
  if (!audOk) return unauthorized(c, bearer.scheme, 'access token audience mismatch')
  // token 验签通过后 client_id 可信:解析 client 用于 CORS 白名单;应用已删则不加 CORS 头。
  const clientId = typeof payload['client_id'] === 'string' ? payload['client_id'] : null
  const client = clientId ? await findClient(c, clientId) : null
  const withCors = (res: Response): Response =>
    client ? applyPublicClientCors(c, client, res, USERINFO_CORS) : res

  if (await isAccessTokenRevoked(c, payload.jti)) {
    return withCors(unauthorized(c, bearer.scheme, 'access token revoked'))
  }
  const dpopErr = await checkDpopBinding(c, {
    scheme: bearer.scheme,
    token: bearer.token,
    cnf: payload['cnf'] as { jkt?: string } | undefined,
  })
  if (dpopErr) return withCors(dpopErr)

  const sub = payload.sub
  const scope = typeof payload['scope'] === 'string' ? payload['scope'] : ''
  if (typeof sub !== 'string') return withCors(unauthorized(c, bearer.scheme, 'token missing sub'))

  const loaded = await loadUser(c, sub)
  if (!loaded) return withCors(unauthorized(c, bearer.scheme, 'user not found'))
  const { user, ...contact } = loaded
  const claims = projectClaims(user, scope, contact)

  return withCors(await respondClaims(c, claims))
}

// Accept 协商(03 章 1 line 13):application/jwt -> 签名 JWT;否则 JSON。
async function respondClaims(
  c: Context<XidHonoEnv>,
  claims: Record<string, unknown>,
): Promise<Response> {
  const accept = c.req.header('accept') ?? ''
  if (accept.includes('application/jwt')) {
    const ctx = c.get('tenant')
    const signer = await loadActiveSigner(ctx, c.env.KEK)
    const jwt = await signJwt(
      { header: { alg: signer.alg, kid: signer.kid }, payload: { iss: ctx.issuer, ...claims } },
      signer.privateKey,
    )
    return c.body(jwt, 200, {
      'content-type': 'application/jwt',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    })
  }
  return c.json(claims, 200, { 'cache-control': 'no-store', pragma: 'no-cache' })
}

// 注册 /userinfo 路由(GET + POST,OIDC Core 5.3.1;OPTIONS 预检给浏览器 SPA)。
export function registerUserinfoRoutes(app: Hono<XidHonoEnv>): void {
  app.options('/userinfo', (c) => handlePublicClientOptions(c, USERINFO_CORS))
  app.get('/userinfo', handleUserinfo)
  app.post('/userinfo', handleUserinfo)
}
