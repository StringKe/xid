// session cookie 签发与校验辅助(对照 docs/design/05-users-sessions.md 8.2 / 8.4 / 8 数据模型)。
// cookie 持 opaque refresh token(crypto.getRandomValues 32 字节 base64url);D1 只存其 SHA-256 哈希,明文不入库。
// 撤销真相源在 SessionDO(per-user active set,binding=SESSION_REVOCATION);D1 sessions 是持久事实。
// 铁律:所有 D1 查询走 @xid-kit/db 租户查询层(自动注入 tenant_id);tenant 从 TenantContext 取不信任 body。

import { base64UrlEncode, sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextBySessionHash, schema } from '@xid-kit/db'
import { DEFAULT_SESSION_POLICY } from '@xid-kit/types'
import type { SessionPolicy } from '@xid-kit/types'
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AuthContextData } from './auth-context'
import { AppError } from './errors'
import {
  clearRefreshTokenCookie,
  readAllRefreshTokenCookies,
  readRefreshTokenCookie,
  setRefreshTokenCookie,
} from './cookies'
import type { ResolvedSessionCandidate, SessionData, XidHonoEnv } from './types'
import type { TenantVar } from './types'
import { recordAuthenticatedSession } from './auth-analytics'

// opaque refresh token 字节数(见 05 章 8.2:32 字节 base64url 约 43 字符)。
const REFRESH_TOKEN_BYTES = 32
const DAY_MS = 24 * 60 * 60 * 1000
// idle touch 节流窗口:登录后高频请求下每次读都写 D1 会把读流量放大成写流量;
// 5min 粒度对 idle 判定(分钟级超时)足够精确,窗口内多次请求只写一次。
const SESSION_TOUCH_THROTTLE_MS = 5 * 60 * 1000
// idle 自然失效的终态标记:与 revoked(主动撤销)语义区分,审计可分辨失效原因。
const EXPIRED_SESSION_STATUS = 'expired'
const SESSION_DO_REQUEST_MAX_ATTEMPTS = 3
const SESSION_DO_RETRY_DELAY_MS = 25
const ACTIVE_ORG_LOOKUP_BATCH_SIZE = 100
export const ACTIVE_SESSION_STATUS = 'active'
export const PENDING_MFA_SESSION_STATUS = 'pending_mfa'
export const PENDING_MFA_SETUP_SESSION_STATUS = 'pending_mfa_setup'

export type ReadSessionStatus =
  | typeof ACTIVE_SESSION_STATUS
  | typeof PENDING_MFA_SESSION_STATUS
  | typeof PENDING_MFA_SETUP_SESSION_STATUS

export const AUTHENTICATED_SESSION_STATUSES: readonly ReadSessionStatus[] = [
  ACTIVE_SESSION_STATUS,
  PENDING_MFA_SESSION_STATUS,
  PENDING_MFA_SETUP_SESSION_STATUS,
]

// per-user SessionDO 实例 key(撤销集,见 cloudflare-bindings rule 会话存储)。
// 签发/单撤销/SCIM deprovision/Management API 强制下线必须命中同一 DO 实例,
// userId 是全局唯一 UUID(users.id 无 tenant 复合主键),无需再拼 tenantId。
export function sessionDoName(userId: string): string {
  return `session:${userId}`
}

// per-user SessionDO stub:三处(签发/单撤销/SCIM/Management API)统一从此取,确保命中同一实例。
export function sessionDoStub(env: Env, userId: string): DurableObjectStub {
  const ns = env.SESSION_REVOCATION
  return ns.get(ns.idFromName(sessionDoName(userId)))
}

type SessionDoAction =
  | 'add'
  | 'generation'
  | 'is-active'
  | 'revoke'
  | 'revoke-all'
  | 'revoke-all-except'

function fetchSessionDo(
  env: Env,
  userId: string,
  action: SessionDoAction,
  body?: Record<string, unknown>,
): Promise<Response> {
  return sessionDoStub(env, userId).fetch(`https://session-do/${action}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
}

// SessionDO 是撤销真相源。非 2xx 说明这次 add/revoke 根本没落到 active set:
// 继续往下走会让"已登出"是假的(用户以为下线、token 仍可用),或让 D1 标 revoked 而 DO 仍放行。
// 因此一律 fail closed:抛错终止调用方流程,不设 cookie、不落 D1。
function assertSessionDoOk(response: Response): void {
  if (response.ok) return
  throw new AppError('server_error', {
    cause: new Error(`SessionDO returned HTTP ${response.status}`),
  })
}

// per-user SessionDO revoke-all:撤销该用户全部 active session(登出所有设备)。
export async function sessionDoRevokeAll(env: Env, userId: string): Promise<void> {
  assertSessionDoOk(await fetchSessionDo(env, userId, 'revoke-all', { userId }))
}

export async function sessionDoRevokeAllExcept(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<void> {
  assertSessionDoOk(await fetchSessionDo(env, userId, 'revoke-all-except', { sessionId }))
}

// per-user SessionDO 单条撤销:me / Management API / revokeSession 共用,统一 fail closed 语义。
export async function sessionDoRevoke(env: Env, userId: string, sessionId: string): Promise<void> {
  assertSessionDoOk(await fetchSessionDo(env, userId, 'revoke', { sessionId }))
}

// 生成 opaque refresh token(Web Crypto 随机数,见 crypto-boundary rule)。
function generateRefreshToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(REFRESH_TOKEN_BYTES)))
}

function normalizeSessionStatus(rowStatus: string): ReadSessionStatus {
  if (rowStatus === PENDING_MFA_SESSION_STATUS) return PENDING_MFA_SESSION_STATUS
  if (rowStatus === PENDING_MFA_SETUP_SESSION_STATUS) return PENDING_MFA_SETUP_SESSION_STATUS
  return ACTIVE_SESSION_STATUS
}

// D1 sessions 行 -> SessionData 视图(不暴露 refreshTokenHash)。
function toSessionData(row: typeof schema.sessions.$inferSelect): SessionData {
  const status = normalizeSessionStatus(row.status)
  return {
    sessionId: row.id,
    userId: row.userId,
    status,
    activeOrgId: row.activeOrgId ?? null,
    authenticatedAt: row.authenticatedAt,
    lastActiveAt: row.lastActiveAt,
    expiresAt: row.expiresAt,
    rememberMe: row.rememberMe,
    isImpersonation: row.isImpersonation,
    impersonatorUserId: row.impersonatorUserId ?? null,
    acr: row.acr ?? null,
    amr: (row.amr ?? null) as SessionData['amr'],
    aal: row.aal ?? null,
  }
}

export function sessionCandidateFromRow(
  refreshTokenHash: string,
  row: typeof schema.sessions.$inferSelect,
): ResolvedSessionCandidate {
  return { refreshTokenHash, session: toSessionData(row) }
}

// SessionDO 投递:add / generation / is-active。DO 暴露 HTTP fetch 接口(action 走 pathname)。
function isRetryableDoError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { retryable?: unknown }).retryable === true
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// SessionDO 的响应体是契约的一部分。形状不符只能是 DO 与调用方漂移,
// 静默回退默认值会把 fencing 判定降级成"接受",与 assertSessionDoOk 的 fail closed 相悖。
async function parseSessionDoBody(response: Response): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  if (!body || typeof body !== 'object') {
    throw new AppError('server_error', {
      cause: new Error('SessionDO returned a non-object body'),
    })
  }
  return body as Record<string, unknown>
}

// expectedGeneration fencing 的唯一判定点:只有明确的 accepted:true / false 才是有效结论。
// 空 body(200 + {})被当成"接受"会让 revoke-all 之后的旧签发把会话复活。
function parseAddAccepted(body: Record<string, unknown>): boolean {
  const value = body['value']
  if (body['ok'] !== true || !value || typeof value !== 'object') {
    throw new AppError('server_error', {
      cause: new Error('SessionDO add response is not an ok Result envelope'),
    })
  }
  const accepted = (value as Record<string, unknown>)['accepted']
  if (typeof accepted !== 'boolean') {
    throw new AppError('server_error', {
      cause: new Error('SessionDO add response has no boolean accepted'),
    })
  }
  return accepted
}

async function doSessionGeneration(env: Env, userId: string): Promise<number> {
  let lastError: unknown
  for (let attempt = 1; attempt <= SESSION_DO_REQUEST_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchSessionDo(env, userId, 'generation')
      assertSessionDoOk(response)
      const generation = (await parseSessionDoBody(response))['generation']
      if (typeof generation !== 'number') {
        throw new AppError('server_error', {
          cause: new Error('SessionDO generation response has no numeric generation'),
        })
      }
      return generation
    } catch (error) {
      lastError = error
      if (!isRetryableDoError(error) || attempt === SESSION_DO_REQUEST_MAX_ATTEMPTS) break
      await delay(SESSION_DO_RETRY_DELAY_MS * attempt)
    }
  }
  throw lastError
}

async function doAddSession(
  env: Env,
  userId: string,
  sessionId: string,
  expectedGeneration: number,
): Promise<boolean> {
  let lastError: unknown
  for (let attempt = 1; attempt <= SESSION_DO_REQUEST_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchSessionDo(env, userId, 'add', { sessionId, expectedGeneration })
      assertSessionDoOk(response)
      return parseAddAccepted(await parseSessionDoBody(response))
    } catch (error) {
      lastError = error
      if (!isRetryableDoError(error) || attempt === SESSION_DO_REQUEST_MAX_ATTEMPTS) break
      await delay(SESSION_DO_RETRY_DELAY_MS * attempt)
    }
  }
  throw lastError
}

// DO 返回非 2xx 或整个不可达时都无法确认 session 还在 active set。此处 false = 视为已撤销 = 拒绝放行,
// 与漏判成"仍然有效"相反,是安全方向;缺失/非布尔的 active 字段同样不当作有效。
// 不把 fetch 异常上抛的原因:上抛会让持有效 cookie 的请求得 500、持伪造 cookie 的请求在更早的
// D1 比对就得 401,DO 故障窗口内两者的响应差异构成 cookie 有效性 oracle,违反枚举防护铁律。
// 故障可见性由日志承担,不由响应差异承担。
async function doIsActive(env: Env, userId: string, sessionId: string): Promise<boolean> {
  try {
    const response = await fetchSessionDo(env, userId, 'is-active', { sessionId })
    if (!response.ok) return false
    const body = (await response.json()) as { active?: unknown }
    return body.active === true
  } catch (err) {
    console.error('[session] SessionDO is-active unreachable, treating session as revoked', err)
    return false
  }
}

async function hasActiveUser(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<boolean> {
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  return Boolean(user)
}

export async function assertActiveSessionUser(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<void> {
  if (!(await hasActiveUser(db, userId))) {
    throw new AppError('invalid_credentials')
  }
}

// policy.session 由 buildPolicy 三层解析后恒存在;兜底默认值只防测试桩与手搓 ctx 缺字段。
function sessionPolicyOf(ctx: TenantVar): SessionPolicy {
  return ctx.policy?.session ?? DEFAULT_SESSION_POLICY
}

// fire-and-forget 写:请求上下文挂 waitUntil 保证写完;无 ExecutionContext(测试/非请求路径)直接驱动 promise。
// 调用方必须传已开始执行的 promise:drizzle 查询是惰性 thenable,仅 void 不 await 永远不执行。
function waitUntilBestEffort(c: Context<XidHonoEnv>, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise)
  } catch {
    void promise
  }
}

// lastActiveAt 为 null(历史行)按 authenticatedAt 兜底,避免老会话被误判无限 idle。
function lastActiveMs(session: { authenticatedAt: Date; lastActiveAt?: Date | null }): number {
  return (session.lastActiveAt ?? session.authenticatedAt).getTime()
}

function isIdleExpired(
  session: { authenticatedAt: Date; lastActiveAt?: Date | null },
  policy: SessionPolicy,
  nowMs: number,
): boolean {
  return nowMs - lastActiveMs(session) > policy.idleTimeoutMin * 60_000
}

// idle 失效:异步把行置 expired(不阻塞读);后续读取直接被 status 白名单拒绝,DO active 集随 read 拒绝即可。
function markSessionExpired(
  c: Context<XidHonoEnv>,
  db: ReturnType<typeof createTenantDb>,
  sessionId: string,
): void {
  waitUntilBestEffort(
    c,
    (async () => {
      await db.sessions.update(
        { status: EXPIRED_SESSION_STATUS },
        eq(schema.sessions.id, sessionId),
      )
    })(),
  )
}

// 滑动续期:距上次活跃超节流窗口才写 lastActiveAt,异步不阻塞读。
// nowMs 内部自取:与 idle 判定共用时间基准没有一致性收益,5min 粒度下毫秒级漂移无感。
function touchSessionLastActive(
  c: Context<XidHonoEnv>,
  db: ReturnType<typeof createTenantDb>,
  sessionId: string,
  lastActiveAtMs: number,
): void {
  const nowMs = Date.now()
  if (nowMs - lastActiveAtMs <= SESSION_TOUCH_THROTTLE_MS) return
  waitUntilBestEffort(
    c,
    (async () => {
      await db.sessions.update({ lastActiveAt: new Date(nowMs) }, eq(schema.sessions.id, sessionId))
    })(),
  )
}

async function tenantForCookie(
  c: Context<XidHonoEnv>,
  refreshTokenHash: string,
): Promise<{ tenant: TenantVar; session?: typeof schema.sessions.$inferSelect } | null> {
  const tenant = c.get('tenant')
  const candidate = c.get('sessionCandidate')
  if (!tenant.resolution?.unresolvedRoot && !candidate) return { tenant }
  const resolved = await resolveTenantContextBySessionHash(c.req.raw, c.env, refreshTokenHash)
  if (!resolved.ok || resolved.value.status !== 'resolved') return null
  return { tenant: resolved.value.tenant, session: resolved.value.session }
}

export type IssueSessionInput = {
  sessionId: string
  userId: string
  status?: ReadSessionStatus
  activeOrgId?: string | null
  // timestamp_ms 列映射 Date(见 packages/db schema/common.ts)。
  authenticatedAt: Date
  // 可选覆盖:默认按 policy.session.absoluteTimeoutDays 计算;仅短期会话(auth/passkey sessionExpiryDays)显式传入。
  expiresAt?: Date
  rememberMe?: boolean
  isImpersonation?: boolean
  impersonatorUserId?: string | null
  authContext?: AuthContextData
  deviceFingerprintHash?: string | null
  deviceName?: string | null
  userAgent?: string | null
  ip?: string | null
  location?: string | null
}

export type IssuedSession = {
  session: SessionData
  refreshToken: string
}

type SessionInsert = typeof schema.sessions.$inferInsert

async function resolveIssueSessionActiveOrgId(
  db: ReturnType<typeof createTenantDb>,
  input: IssueSessionInput,
): Promise<string | null> {
  if (Object.hasOwn(input, 'activeOrgId')) return input.activeOrgId ?? null

  const membershipFilter = and(
    eq(schema.memberships.userId, input.userId),
    eq(schema.memberships.status, 'active'),
  )
  const activeOrgIds: string[] = []
  let cursor: string | null = null

  while (activeOrgIds.length < 2) {
    const memberships = await db.memberships.findMany(
      cursor ? and(membershipFilter, gt(schema.memberships.id, cursor)) : membershipFilter,
      { orderBy: asc(schema.memberships.id), limit: ACTIVE_ORG_LOOKUP_BATCH_SIZE },
    )
    if (memberships.length === 0) break

    const orgIds = [...new Set(memberships.map((membership) => membership.orgId))]
    const organizations = await db.organizations.findMany(
      and(
        inArray(schema.organizations.id, orgIds),
        eq(schema.organizations.status, 'active'),
        isNull(schema.organizations.deletedAt),
      ),
      { limit: orgIds.length },
    )
    const activeIds = new Set(organizations.map((organization) => organization.id))
    for (const membership of memberships) {
      if (!activeIds.has(membership.orgId) || activeOrgIds.includes(membership.orgId)) continue
      activeOrgIds.push(membership.orgId)
      if (activeOrgIds.length === 2) break
    }

    if (memberships.length < ACTIVE_ORG_LOOKUP_BATCH_SIZE) break
    const last = memberships[memberships.length - 1]
    if (!last || last.id === cursor) break
    cursor = last.id
  }

  return activeOrgIds.length === 1 ? (activeOrgIds[0] ?? null) : null
}

// 组装 sessions 插入行(可选字段统一回退 null/默认)。tenantId 由租户查询层覆盖,此处给 ctx 值。
function buildSessionInsert(
  input: IssueSessionInput & { expiresAt: Date },
  tenantId: string,
  refreshTokenHash: string,
): SessionInsert {
  return {
    tenantId,
    id: input.sessionId,
    userId: input.userId,
    refreshTokenHash,
    activeOrgId: input.activeOrgId ?? null,
    deviceFingerprintHash: input.deviceFingerprintHash ?? null,
    deviceName: input.deviceName ?? null,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
    location: input.location ?? null,
    status: input.status ?? ACTIVE_SESSION_STATUS,
    rememberMe: input.rememberMe ?? false,
    isImpersonation: input.isImpersonation ?? false,
    impersonatorUserId: input.impersonatorUserId ?? null,
    acr: input.authContext?.acr ?? null,
    amr: input.authContext ? [...input.authContext.amr] : null,
    aal: input.authContext?.aal ?? null,
    authenticatedAt: input.authenticatedAt,
    lastActiveAt: new Date(),
    expiresAt: input.expiresAt,
  }
}

// 创建 session:生成 opaque refresh token -> 写 D1(存哈希)-> SessionDO addSession -> 设 cookie。
// 返回明文 refresh token(仅用于已设入 cookie,调用方一般不再持有)。
export async function issueSession(
  c: Context<XidHonoEnv>,
  input: IssueSessionInput,
): Promise<IssuedSession> {
  const env = c.env
  const ctx = c.get('tenant')
  const sessionPolicy = sessionPolicyOf(ctx)
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + sessionPolicy.absoluteTimeoutDays * DAY_MS)
  const refreshToken = generateRefreshToken()
  const refreshTokenHash = await sha256Hex(refreshToken)

  const db = createTenantDb(env.DB, ctx)
  await assertActiveSessionUser(db, input.userId)
  const activeOrgId = await resolveIssueSessionActiveOrgId(db, input)
  const expectedGeneration = await doSessionGeneration(env, input.userId)
  const row = await db.sessions.insert(
    buildSessionInsert({ ...input, activeOrgId, expiresAt }, ctx.tenantId, refreshTokenHash),
  )

  const accepted = await doAddSession(env, input.userId, input.sessionId, expectedGeneration)
  if (!accepted) {
    await db.sessions.update({ status: 'revoked' }, eq(schema.sessions.id, input.sessionId))
    throw new AppError('session_revoked')
  }
  setRefreshTokenCookie(c, {
    sessionId: input.sessionId,
    token: refreshToken,
    // 记住我 cookie 生命周期对齐 session absolute 策略;非记住我不设 Max-Age(浏览器会话生命周期)。
    ...(input.rememberMe ? { maxAgeSec: sessionPolicy.absoluteTimeoutDays * 24 * 60 * 60 } : {}),
  })
  const telemetry = recordAuthenticatedSession({
    env,
    tenant: ctx,
    userId: input.userId,
    status: row.status as ReadSessionStatus,
    timestamp: Date.now(),
  })
  waitUntilBestEffort(c, telemetry)

  return { session: toSessionData(row), refreshToken }
}

// 校验单个 session:cookie opaque token -> SHA-256 -> D1 查 status/过期 -> SessionDO is-active。
// 任一不通过返回 null(枚举防护:不区分缺失/无效/已撤销)。
export async function readSessionById(
  c: Context<XidHonoEnv>,
  sessionId: string,
  allowedStatuses: readonly ReadSessionStatus[] = [ACTIVE_SESSION_STATUS],
): Promise<SessionData | null> {
  const env = c.env
  const ctx = c.get('tenant')
  const token = readRefreshTokenCookie(c, sessionId)
  if (!token) return null

  const refreshTokenHash = await sha256Hex(token)
  const db = createTenantDb(env.DB, ctx)
  const row = await db.sessions.findOne(eq(schema.sessions.id, sessionId))
  if (!row || row.refreshTokenHash !== refreshTokenHash) return null
  if (!allowedStatuses.includes(row.status as ReadSessionStatus)) return null
  const nowMs = Date.now()
  if (row.expiresAt.getTime() <= nowMs) return null
  if (isIdleExpired(row, sessionPolicyOf(ctx), nowMs)) {
    markSessionExpired(c, db, row.id)
    return null
  }
  if (!(await hasActiveUser(db, row.userId))) return null

  const active = await doIsActive(env, row.userId, sessionId)
  if (!active) return null

  touchSessionLastActive(c, db, row.id, lastActiveMs(row))
  return toSessionData(row)
}

// 从请求 cookie 解析当前 session(取第一个校验通过的 __Host-xid.rt.* cookie)。
// session 中间件用此填充 c.set('session')。多 session 下返回首个有效项。
export async function readSession(
  c: Context<XidHonoEnv>,
  allowedStatuses: readonly ReadSessionStatus[] = [ACTIVE_SESSION_STATUS],
): Promise<SessionData | null> {
  const env = c.env
  const all = Object.values(readAllRefreshTokenCookies(c))
  if (all.length === 0) return null

  for (const token of all) {
    const refreshTokenHash = await sha256Hex(token)
    const preResolved = c.get('sessionCandidate')
    if (preResolved?.refreshTokenHash === refreshTokenHash) {
      const session = preResolved.session
      if (!allowedStatuses.includes(session.status)) continue
      const nowMs = Date.now()
      if (session.expiresAt.getTime() <= nowMs) continue
      const db = createTenantDb(env.DB, c.get('tenant'))
      if (isIdleExpired(session, sessionPolicyOf(c.get('tenant')), nowMs)) {
        markSessionExpired(c, db, session.sessionId)
        continue
      }
      const [activeUser, active] = await Promise.all([
        hasActiveUser(db, session.userId),
        doIsActive(env, session.userId, session.sessionId),
      ])
      if (!activeUser || !active) continue
      touchSessionLastActive(c, db, session.sessionId, lastActiveMs(session))
      return session
    }

    const candidate = await tenantForCookie(c, refreshTokenHash)
    if (!candidate) continue
    const db = createTenantDb(env.DB, candidate.tenant)
    const row =
      candidate.session ??
      (await db.sessions.findOne(eq(schema.sessions.refreshTokenHash, refreshTokenHash)))
    if (!row) continue
    if (!allowedStatuses.includes(row.status as ReadSessionStatus)) continue
    const nowMs = Date.now()
    if (row.expiresAt.getTime() <= nowMs) continue
    if (isIdleExpired(row, sessionPolicyOf(candidate.tenant), nowMs)) {
      markSessionExpired(c, db, row.id)
      continue
    }
    const [activeUser, active] = await Promise.all([
      hasActiveUser(db, row.userId),
      doIsActive(env, row.userId, row.id),
    ])
    if (!activeUser || !active) continue
    touchSessionLastActive(c, db, row.id, lastActiveMs(row))
    c.set('tenant', candidate.tenant)
    return toSessionData(row)
  }
  return null
}

// 撤销 session:SessionDO revoke + D1 status=revoked + 清 cookie(见 05 章 8 撤销)。
export async function revokeSession(c: Context<XidHonoEnv>, session: SessionData): Promise<void> {
  const env = c.env
  const ctx = c.get('tenant')
  await sessionDoRevoke(env, session.userId, session.sessionId)
  const db = createTenantDb(env.DB, ctx)
  await db.sessions.update({ status: 'revoked' }, eq(schema.sessions.id, session.sessionId))
  clearRefreshTokenCookie(c, session.sessionId)
}
