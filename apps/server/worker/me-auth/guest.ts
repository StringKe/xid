// POST /auth/guest:Firebase 式访客(匿名)登录,无认证入口。
// 行为契约(docs/design/01-authentication.md guest 模式):
//   1. 先查后建:请求已带有效 guest session(user provisioned_by = 'anonymous')直接 200 返回,不建号。
//   2. 否则建号:users.insert(provisionedBy = 'anonymous',走 createTenantDb)+ issueSession(amr 含 'guest')。
//   3. 并发去重:带 anonKey cookie 走 GuestStore DO 串行 check-and-set;裸请求直接建(限流兜底)。
//   4. 防护:Turnstile(TURNSTILE_SECRET 配置时强制)+ RateLimitStore(IP + anonKey 维度)+ 每租户每日铸造上限。
//   5. 审计:guest.created 走 AUDIT_QUEUE(waitUntil 不阻塞登录链路,见 cloudflare-bindings rule)。
// 枚举防护:响应只含本次签发的 sessionId,绝不携带任何既有账号信息。

import { createTenantDb, schema, USER_PROVISIONED_BY_ANONYMOUS } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { ACTIVE_SESSION_STATUS, issueSession, readSession, sessionPolicyOf } from '../lib/session'
import { GUEST_AUTH_CONTEXT } from '../lib/auth-context'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { readJsonBody, validateCredentialBody } from '../lib/validate'
import { GUEST_DAILY_MINT_LIMIT } from '../lib/ttl'
import type { RateLimitPolicy } from '../durable-objects/rate-limit-store'
import { ANON_KEY_COOKIE, getOrCreateAnonKey, readAnonKey } from '../auth/passkey-helpers'
import { checkRateLimit, requestIp, requestUserAgent, verifyTurnstile } from './shared'

const guestBodySchema = v.object({
  turnstileToken: v.optional(v.nullable(v.string())),
})

const DAY_MS = 24 * 60 * 60 * 1000

// 每租户每日 guest 铸造上限(限流兜底第四层,见 anti-abuse rule;阈值常量在 lib/ttl.ts)。
const GUEST_MINT_PER_DAY_POLICY: RateLimitPolicy = {
  windowMs: 24 * 60 * 60 * 1000,
  maxRequests: GUEST_DAILY_MINT_LIMIT,
  lockDurationMs: 0,
}

// ---- GuestStore DO client(fail closed,对齐 challenge-store 调用约定)----

function guestStoreStub(env: Env, tenantId: string, anonKey: string): DurableObjectStub {
  const ns = env.GUEST_STORE
  return ns.get(ns.idFromName(`${tenantId}:${anonKey}`))
}

type GuestStoreTarget = { tenantId: string; anonKey: string }

async function postGuestStore(
  env: Env,
  target: GuestStoreTarget,
  action: 'lookup' | 'bind' | 'unbind',
  body?: Record<string, unknown>,
): Promise<Response> {
  return guestStoreStub(env, target.tenantId, target.anonKey).fetch(
    `https://guest-store/${action}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
  )
}

// 解绑:转正/绑定失效后调用。不校验状态码 -- 陈旧绑定会在下次 lookup 时被
// loadLiveGuestUser 拒绝并自愈(见 handleGuestSignIn 第 2 步),不阻断调用方流程。
export async function unbindGuestAnonKey(
  env: Env,
  tenantId: string,
  anonKey: string,
): Promise<void> {
  await postGuestStore(env, { tenantId, anonKey }, 'unbind')
}

// 既有绑定查询:404 = 无绑定;其余非 200 视为 DO 故障,fail closed 不建号。
async function lookupGuestBinding(env: Env, target: GuestStoreTarget): Promise<string | null> {
  const res = await postGuestStore(env, target, 'lookup')
  if (res.status === 404) return null
  if (res.status !== 200) throw new AppError('server_error')
  const body = (await res.json()) as { userId?: unknown }
  if (typeof body.userId !== 'string' || body.userId.length === 0) {
    throw new AppError('server_error')
  }
  return body.userId
}

// check-and-set 绑定:created=false 表示并发竞争落败,返回既有绑定的 userId。
// ttlMs 由调用方按租户 session policy 推导(铁律:tenant policy 出自 TenantContext)。
async function bindGuestUser(
  env: Env,
  target: GuestStoreTarget,
  userId: string,
  ttlMs: number,
): Promise<{ userId: string; created: boolean }> {
  const res = await postGuestStore(env, target, 'bind', {
    userId,
    ttlMs,
  })
  if (res.status !== 200) throw new AppError('server_error')
  const body = (await res.json()) as { userId?: unknown; created?: unknown }
  if (typeof body.userId !== 'string' || typeof body.created !== 'boolean') {
    throw new AppError('server_error')
  }
  return { userId: body.userId, created: body.created }
}

// ---- handler 内部 ----

type GuestDb = ReturnType<typeof createTenantDb>

// 有效 guest 账号判定:绑定/会话指向的 user 必须仍是在租的 anonymous 账号
// (被 GC 软删或已转正的账号不再接受续签,回退到建号路径)。
// 导出供 guest-conversion 复用(转正四路径同一判定)。
export async function loadLiveGuestUser(
  db: GuestDb,
  userId: string,
): Promise<{ id: string } | null> {
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user || user.provisionedBy !== USER_PROVISIONED_BY_ANONYMOUS) return null
  return { id: user.id }
}

async function issueGuestSession(c: Context<XidHonoEnv>, userId: string): Promise<Response> {
  const sessionId = crypto.randomUUID()
  await issueSession(c, {
    sessionId,
    userId,
    // guest 不属于任何 org,显式 null 跳过 membership 扫描。
    activeOrgId: null,
    authContext: GUEST_AUTH_CONTEXT,
    authenticatedAt: new Date(),
    ip: requestIp(c),
    userAgent: requestUserAgent(c),
  })
  return c.json({ sessionId })
}

// 审计不阻塞登录链路(cloudflare-bindings rule):入队挂 waitUntil,失败只进日志。
function emitGuestCreatedAudit(c: Context<XidHonoEnv>, tenantId: string, userId: string): void {
  const task = c.env.AUDIT_QUEUE.send({
    tenantId,
    action: 'guest.created',
    actorId: userId,
    ts: Date.now(),
    payload: { targetType: 'user', targetId: userId },
  })
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task.catch((error: unknown) => console.error('[guest] audit queue send failed', error))
  }
}

// 新请求(无 anonKey cookie)补种匿名 key:后续重试/并发即可走 GuestStore 去重。
function setAnonKeyCookie(c: Context<XidHonoEnv>, anonKey: string, maxAgeSec: number): void {
  c.header(
    'Set-Cookie',
    `${ANON_KEY_COOKIE}=${anonKey}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`,
    { append: true },
  )
}

async function createGuestUser(db: GuestDb, tenant: TenantVar): Promise<string> {
  const userId = crypto.randomUUID()
  await db.users.insert({
    id: userId,
    tenantId: tenant.tenantId,
    status: 'active',
    provisionedBy: USER_PROVISIONED_BY_ANONYMOUS,
    isNewUser: true,
  })
  return userId
}

export async function handleGuestSignIn(c: Context<XidHonoEnv>): Promise<Response> {
  // body 可空:POST 无 body 视为 {}(访客入口不强制任何字段)。
  const json = await readJsonBody(c)
  const body = json.ok
    ? validateCredentialBody(guestBodySchema, json.value, {
        code: 'invalid_request',
        credentialFields: [],
      })
    : { turnstileToken: null }

  const tenant = c.get('tenant')
  const ip = requestIp(c)
  await verifyTurnstile(body.turnstileToken ?? null, c.env, ip)

  const anonKey = readAnonKey(c)
  // 每次请求一次的 check-and-increment:IP 维度 + anonKey(无法确定时仅 IP),对齐既有登录限流。
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: 'guest',
    account: anonKey,
    ip,
  })

  const db = createTenantDb(c.env.DB, tenant)

  // 1. 先查:已持有效 guest session 直接返回,不建号。
  const current = c.get('session') ?? (await readSession(c, [ACTIVE_SESSION_STATUS]))
  if (current?.status === ACTIVE_SESSION_STATUS && (await loadLiveGuestUser(db, current.userId))) {
    return c.json({ sessionId: current.sessionId })
  }

  // 2. anonKey 已绑定 guest:续签(绑定指向已 GC/转正账号时解绑,落入建号路径)。
  if (anonKey) {
    const target = { tenantId: tenant.tenantId, anonKey }
    const boundUserId = await lookupGuestBinding(c.env, target)
    if (boundUserId) {
      if (await loadLiveGuestUser(db, boundUserId)) {
        return issueGuestSession(c, boundUserId)
      }
      await postGuestStore(c.env, target, 'unbind')
    }
  }

  // 3. 建号:先扣每日铸造配额(只在真正铸造时计),再插 user。
  if (
    !(await checkRateLimit(c.env, `guest:mint:day:${tenant.tenantId}`, GUEST_MINT_PER_DAY_POLICY))
  ) {
    throw new AppError('rate_limited')
  }
  const userId = await createGuestUser(db, tenant)

  // 4. 并发去重:DO check-and-set;落败则软删刚建的用户,改用既有绑定续签。
  // bind 失败(DO 故障)时必须软删刚建的用户,否则残留无 session 无绑定的孤儿账号。
  if (anonKey) {
    const guestTtlMs = sessionPolicyOf(tenant).absoluteTimeoutDays * DAY_MS
    let bound: { userId: string; created: boolean }
    try {
      bound = await bindGuestUser(c.env, { tenantId: tenant.tenantId, anonKey }, userId, guestTtlMs)
    } catch (error) {
      await db.users.update(
        { deletedAt: new Date(), status: 'deleted' },
        eq(schema.users.id, userId),
      )
      throw error
    }
    if (!bound.created) {
      await db.users.update(
        { deletedAt: new Date(), status: 'deleted' },
        eq(schema.users.id, userId),
      )
      return issueGuestSession(c, bound.userId)
    }
  } else {
    const guestTtlMs = sessionPolicyOf(tenant).absoluteTimeoutDays * DAY_MS
    setAnonKeyCookie(c, getOrCreateAnonKey(c), guestTtlMs / 1000)
  }

  emitGuestCreatedAudit(c, tenant.tenantId, userId)
  return issueGuestSession(c, userId)
}
