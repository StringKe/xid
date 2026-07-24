// DeviceFlowStore:RFC8628 Device Authorization Grant。
// device_code 与 user_code 分离存储,含 interval/expires_in,polling 限速。
// 见 oidc-oauth rule / docs/design/03-oidc-oauth.md。
//
// DO name = tenantId,一个租户一个 DO 实例,串行保证。
// 操作:
//   POST /create   创建 device_code/user_code,设置过期时间
//   POST /lookup   用户端只读查询:按 user_code 取待授权请求
//   POST /poll     设备端轮询:检查授权状态,限速(interval/slow_down)
//   POST /authorize 用户端授权:绑定 user_code 到登录用户
//   POST /deny      用户拒绝
//   POST /cleanup   alarm 触发清理过期条目

// device_code:发给设备,保密;user_code:发给用户,短易输入
// 状态机: pending -> approved | denied | expired

export const DEVICE_GRANT_STATUS = ['pending', 'approved', 'denied'] as const
export type DeviceGrantStatus = (typeof DEVICE_GRANT_STATUS)[number]

export type DeviceGrantEntry = {
  deviceCode: string
  // user_code 索引:存两份 key,device_code -> entry,user_code -> deviceCode
  userCode: string
  clientId: string
  tenantId: string
  scopes: string[]
  status: DeviceGrantStatus
  // 轮询控制
  interval: number // 建议轮询间隔(秒),初始 5s
  lastPollAt: number // 上次 poll 时间戳
  slowDownCount: number // 连续 too_fast 次数,每次 +5s interval
  // 授权结果
  approvedUserId?: string
  approvedAt?: number
  // 过期
  expiresAt: number
}

type CreateBody = {
  deviceCode: string
  userCode: string
  clientId: string
  tenantId: string
  scopes: string[]
  interval: number
  expiresAt: number
}

type PollBody = {
  deviceCode: string
  // token 端点已认证的 client_id;校验与 device_code 绑定的 client 一致(防 client 混淆 / device-code 劫持)。
  clientId: string
}

type LookupBody = {
  userCode: string
}

type AuthorizeBody = {
  userCode: string
  userId: string
}

type DenyBody = {
  userCode: string
}

// 轮询间隔最小值(秒);slow_down 每次累加 5s,上限 30s
const BASE_INTERVAL_S = 5
const SLOW_DOWN_STEP_S = 5
const MAX_INTERVAL_S = 30
// user_code 索引 key 前缀
const USER_CODE_PREFIX = 'uc:'

export class DeviceFlowStore {
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method !== 'POST') {
      return jsonError(405, 'method_not_allowed', 'Method Not Allowed')
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, 'invalid_request', 'Invalid JSON body')
    }

    switch (url.pathname) {
      case '/create':
        return this.handleCreate(body)
      case '/lookup':
        return this.handleLookup(body)
      case '/poll':
        return this.handlePoll(body)
      case '/authorize':
        return this.handleAuthorize(body)
      case '/deny':
        return this.handleDeny(body)
      case '/cleanup':
        return this.handleCleanup()
      default:
        return jsonError(404, 'not_found', 'Unknown path')
    }
  }

  async alarm(): Promise<void> {
    await this.handleCleanup()
  }

  private async handleCreate(body: unknown): Promise<Response> {
    if (!isCreateBody(body)) {
      return jsonError(400, 'invalid_request', 'Missing required fields for device grant creation')
    }

    const now = Date.now()
    if (body.expiresAt <= now) {
      return jsonError(400, 'invalid_request', 'expiresAt must be in the future')
    }

    const entry: DeviceGrantEntry = {
      deviceCode: body.deviceCode,
      userCode: body.userCode,
      clientId: body.clientId,
      tenantId: body.tenantId,
      scopes: body.scopes,
      status: 'pending',
      interval: body.interval >= BASE_INTERVAL_S ? body.interval : BASE_INTERVAL_S,
      lastPollAt: 0,
      slowDownCount: 0,
      expiresAt: body.expiresAt,
    }

    // 两个索引:device_code 和 user_code
    await this.state.storage.put(body.deviceCode, entry)
    await this.state.storage.put(USER_CODE_PREFIX + body.userCode.toUpperCase(), body.deviceCode)

    // alarm 保证最早过期时间触发清理
    const currentAlarm = await this.state.storage.getAlarm()
    if (currentAlarm === null || body.expiresAt < currentAlarm) {
      await this.state.storage.setAlarm(body.expiresAt)
    }

    return jsonOk({ created: true })
  }

  private async handlePoll(body: unknown): Promise<Response> {
    if (!isPollBody(body)) {
      return jsonError(400, 'invalid_request', 'Missing required field: deviceCode')
    }

    const entry = await this.state.storage.get<DeviceGrantEntry>(body.deviceCode)

    if (entry === undefined) {
      return jsonError(400, 'expired_token', 'device_code not found or expired')
    }

    // client 绑定校验:token 端点已认证的 client 必须与发起 device flow 的 client 一致(RFC8628 安全)。
    if (entry.clientId !== body.clientId) {
      return jsonError(400, 'invalid_grant', 'device_code not bound to this client')
    }

    const now = Date.now()

    if (now > entry.expiresAt) {
      await this.state.storage.delete(body.deviceCode)
      await this.state.storage.delete(USER_CODE_PREFIX + entry.userCode.toUpperCase())
      return jsonError(400, 'expired_token', 'device_code has expired')
    }

    // 限速:距上次合法 poll 不足 interval 返回 slow_down(RFC8628 3.5),否则更新 lastPollAt。
    const slowDown = await this.checkPollRate(body.deviceCode, entry, now)
    if (slowDown) return slowDown

    if (entry.status === 'pending') {
      return jsonError(400, 'authorization_pending', 'User has not yet authorized the request')
    }

    if (entry.status === 'denied') {
      // 用户拒绝后清理
      await this.state.storage.delete(body.deviceCode)
      await this.state.storage.delete(USER_CODE_PREFIX + entry.userCode.toUpperCase())
      return jsonError(400, 'access_denied', 'User denied the authorization request')
    }

    // approved:返回授权结果,清理(token 端点凭此颁发 token 后不再 poll)
    await this.state.storage.delete(body.deviceCode)
    await this.state.storage.delete(USER_CODE_PREFIX + entry.userCode.toUpperCase())

    return jsonOk({
      approved: true,
      userId: entry.approvedUserId,
      scopes: entry.scopes,
      clientId: entry.clientId,
      tenantId: entry.tenantId,
    })
  }

  // poll 限速(RFC8628 3.5):过快返回 slow_down(首次过快 +5s,不更新 lastPollAt 锚点);
  // 否则更新 lastPollAt 并返回 null 让调用方继续。
  private async checkPollRate(
    deviceCode: string,
    entry: DeviceGrantEntry,
    now: number,
  ): Promise<Response | null> {
    const intervalMs = entry.interval * 1000
    if (entry.lastPollAt > 0 && now - entry.lastPollAt < intervalMs) {
      const newSlowDownCount = entry.slowDownCount + 1
      const newIntervalS =
        entry.slowDownCount === 0
          ? Math.min(entry.interval + SLOW_DOWN_STEP_S, MAX_INTERVAL_S)
          : entry.interval
      await this.state.storage.put(deviceCode, {
        ...entry,
        interval: newIntervalS,
        slowDownCount: newSlowDownCount,
      })
      return jsonError(400, 'slow_down', `Poll too fast. New interval: ${newIntervalS}s`)
    }
    await this.state.storage.put(deviceCode, { ...entry, lastPollAt: now })
    return null
  }

  private async handleLookup(body: unknown): Promise<Response> {
    if (!isLookupBody(body)) {
      return jsonError(400, 'invalid_request', 'Missing required field: userCode')
    }

    const ucKey = USER_CODE_PREFIX + body.userCode.toUpperCase()
    const deviceCode = await this.state.storage.get<string>(ucKey)
    if (deviceCode === undefined) {
      return jsonError(400, 'invalid_request', 'user_code not found or expired')
    }

    const entry = await this.state.storage.get<DeviceGrantEntry>(deviceCode)
    if (entry === undefined) {
      await this.state.storage.delete(ucKey)
      return jsonError(400, 'expired_token', 'Associated device_code not found or expired')
    }

    if (Date.now() > entry.expiresAt) {
      await this.state.storage.delete(deviceCode)
      await this.state.storage.delete(ucKey)
      return jsonError(400, 'expired_token', 'device_code has expired')
    }

    if (entry.status !== 'pending') {
      return jsonError(400, 'invalid_request', `Grant already in state: ${entry.status}`)
    }

    return jsonOk({
      userCode: entry.userCode,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt,
    })
  }

  private async handleAuthorize(body: unknown): Promise<Response> {
    if (!isAuthorizeBody(body)) {
      return jsonError(400, 'invalid_request', 'Missing required fields: userCode, userId')
    }

    const ucKey = USER_CODE_PREFIX + body.userCode.toUpperCase()
    const deviceCode = await this.state.storage.get<string>(ucKey)

    if (deviceCode === undefined) {
      return jsonError(400, 'invalid_request', 'user_code not found or expired')
    }

    const entry = await this.state.storage.get<DeviceGrantEntry>(deviceCode)

    if (entry === undefined) {
      await this.state.storage.delete(ucKey)
      return jsonError(400, 'expired_token', 'Associated device_code not found or expired')
    }

    if (Date.now() > entry.expiresAt) {
      await this.state.storage.delete(deviceCode)
      await this.state.storage.delete(ucKey)
      return jsonError(400, 'expired_token', 'device_code has expired')
    }

    if (entry.status !== 'pending') {
      return jsonError(400, 'invalid_request', `Grant already in state: ${entry.status}`)
    }

    const now = Date.now()
    const updated: DeviceGrantEntry = {
      ...entry,
      status: 'approved',
      approvedUserId: body.userId,
      approvedAt: now,
    }
    await this.state.storage.put(deviceCode, updated)

    return jsonOk({ authorized: true })
  }

  private async handleDeny(body: unknown): Promise<Response> {
    if (!isDenyBody(body)) {
      return jsonError(400, 'invalid_request', 'Missing required field: userCode')
    }

    const ucKey = USER_CODE_PREFIX + body.userCode.toUpperCase()
    const deviceCode = await this.state.storage.get<string>(ucKey)

    if (deviceCode === undefined) {
      return jsonError(400, 'invalid_request', 'user_code not found or expired')
    }

    const entry = await this.state.storage.get<DeviceGrantEntry>(deviceCode)

    if (entry === undefined) {
      await this.state.storage.delete(ucKey)
      return jsonError(400, 'expired_token', 'Associated device_code not found or expired')
    }

    if (entry.status !== 'pending') {
      return jsonError(400, 'invalid_request', `Grant already in state: ${entry.status}`)
    }

    const updated: DeviceGrantEntry = { ...entry, status: 'denied' }
    await this.state.storage.put(deviceCode, updated)

    return jsonOk({ denied: true })
  }

  private async handleCleanup(): Promise<Response> {
    const now = Date.now()
    const all = await this.state.storage.list<DeviceGrantEntry | string>()
    const toDelete = collectExpiredKeys(all, now)

    if (toDelete.length > 0) {
      await this.state.storage.delete(toDelete)
    }

    // 设置下一次 alarm
    const remaining = await this.state.storage.list<DeviceGrantEntry | string>()
    const nextAlarm = findNextAlarm(remaining)
    if (nextAlarm !== null) {
      await this.state.storage.setAlarm(nextAlarm)
    }

    return jsonOk({ deleted: toDelete.length })
  }
}

// --- cleanup 辅助 ---

function isDeviceGrantEntry(v: unknown): v is DeviceGrantEntry {
  return typeof v === 'object' && v !== null && 'expiresAt' in v && 'userCode' in v
}

function collectExpiredKeys(all: Map<string, DeviceGrantEntry | string>, now: number): string[] {
  const toDelete: string[] = []
  for (const [key, value] of all) {
    if (isDeviceGrantEntry(value) && value.expiresAt <= now) {
      toDelete.push(key)
      toDelete.push(USER_CODE_PREFIX + value.userCode.toUpperCase())
    }
  }
  return toDelete
}

function findNextAlarm(all: Map<string, DeviceGrantEntry | string>): number | null {
  let nextAlarm: number | null = null
  for (const [, value] of all) {
    if (isDeviceGrantEntry(value)) {
      if (nextAlarm === null || value.expiresAt < nextAlarm) {
        nextAlarm = value.expiresAt
      }
    }
  }
  return nextAlarm
}

// --- 类型守卫 ---

function isCreateBody(v: unknown): v is CreateBody {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['deviceCode'] === 'string' &&
    typeof o['userCode'] === 'string' &&
    typeof o['clientId'] === 'string' &&
    typeof o['tenantId'] === 'string' &&
    Array.isArray(o['scopes']) &&
    typeof o['interval'] === 'number' &&
    typeof o['expiresAt'] === 'number'
  )
}

function isPollBody(v: unknown): v is PollBody {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['deviceCode'] === 'string' && typeof o['clientId'] === 'string'
}

function isLookupBody(v: unknown): v is LookupBody {
  if (typeof v !== 'object' || v === null) return false
  return typeof (v as Record<string, unknown>)['userCode'] === 'string'
}

function isAuthorizeBody(v: unknown): v is AuthorizeBody {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['userCode'] === 'string' && typeof o['userId'] === 'string'
}

function isDenyBody(v: unknown): v is DenyBody {
  if (typeof v !== 'object' || v === null) return false
  return typeof (v as Record<string, unknown>)['userCode'] === 'string'
}

// --- 响应工具 ---

function jsonOk(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
