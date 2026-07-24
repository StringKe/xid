// GET /auth/device-activation + POST /auth/device-activation(前端 /activate;须已登录)。
// Device Flow 用户端 activation:按 user_code 查询待授权请求,approve/deny 调 DEVICE_FLOW DO。
// 铁律:userId 从 session 取,不信任 body;tenant 从 TenantContext 取;DO name=tenantId。

import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { findClient } from '../oidc/shared'
import { firstIssuePath, readJsonBody } from '../lib/validate'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { requestIp, requireSession } from './shared'

type DeviceActivationLookup = {
  userCode: string
  clientId: string
  scopes: string[]
  expiresAt: number
}

const deviceActivationBodySchema = v.object({
  userCode: v.string(),
  approved: v.optional(v.boolean()),
})

const deviceActivationQuerySchema = v.object({
  user_code: v.string(),
})

function invalidUserCodeError(paramName: string): AppError {
  return new AppError('invalid_request', {
    meta: { paramName },
    longMessage: `${paramName} is required`,
  })
}

function deviceFlowStub(env: Env, tenantId: string): DurableObjectStub {
  const ns = env.DEVICE_FLOW
  return ns.get(ns.idFromName(tenantId))
}

async function callDeviceFlow(
  env: Env,
  tenantId: string,
  path: '/lookup' | '/authorize' | '/deny',
  body: Record<string, unknown>,
): Promise<Response> {
  return deviceFlowStub(env, tenantId).fetch(`https://device-flow${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readDeviceFlowError(res: Response): Promise<AppError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    error_description?: string
  }
  const code = body.error
  if (
    code === 'invalid_request' ||
    code === 'expired_token' ||
    code === 'access_denied' ||
    code === 'authorization_pending'
  ) {
    return new AppError(code, { longMessage: body.error_description })
  }
  return new AppError('server_error', {
    longMessage: body.error_description ?? 'Device activation failed',
  })
}

async function lookupGrant(
  c: Context<XidHonoEnv>,
  userCode: string,
): Promise<DeviceActivationLookup> {
  const tenant = c.get('tenant')
  const res = await callDeviceFlow(c.env, tenant.tenantId, '/lookup', { userCode })
  if (!res.ok) throw await readDeviceFlowError(res)
  return (await res.json()) as DeviceActivationLookup
}

// user_code 仅 8 位,在线暴破可枚举有效 code 并越权批准设备:按 session 用户限流
// (10 次/15min + IP 50/min,verify-rate-limit 单点计数,成功/失败统一计入防探测)。
async function enforceUserCodeRateLimit(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<void> {
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: c.get('tenant').tenantId,
    scope: 'device-activation',
    account: session.userId,
    ip: requestIp(c),
  })
}

// GET /auth/device-activation?user_code= -- 返回用户端展示数据。
export async function handleDeviceActivationParams(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const query = v.safeParse(deviceActivationQuerySchema, { user_code: c.req.query('user_code') })
  if (!query.success) throw invalidUserCodeError('user_code')
  const userCode = query.output.user_code.trim()
  if (!userCode) throw invalidUserCodeError('user_code')

  await enforceUserCodeRateLimit(c, session)
  const grant = await lookupGrant(c, userCode)
  const client = await findClient(c, grant.clientId)
  if (!client) throw new AppError('invalid_client', { httpStatus: 400 })

  return c.json({
    userCode: grant.userCode,
    clientId: client.clientId,
    scopes: grant.scopes,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    firstParty: client.firstParty,
  })
}

// POST /auth/device-activation { userCode, approved } -- 用户批准或拒绝 Device Flow 请求。
export async function handleDeviceActivation(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw invalidUserCodeError('userCode')
  const parsed = v.safeParse(deviceActivationBodySchema, json.value)
  if (!parsed.success) {
    const paramName = firstIssuePath(parsed.issues)
    if (paramName.split('.')[0] === 'userCode') throw invalidUserCodeError('userCode')
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  const body = parsed.output
  const userCode = body.userCode.trim()
  if (!userCode) throw invalidUserCodeError('userCode')

  await enforceUserCodeRateLimit(c, session)
  const path = body.approved === true ? '/authorize' : '/deny'
  const payload = path === '/authorize' ? { userCode, userId: session.userId } : { userCode }
  const res = await callDeviceFlow(c.env, tenant.tenantId, path, payload)
  if (!res.ok) throw await readDeviceFlowError(res)
  return c.json({ approved: body.approved === true })
}
