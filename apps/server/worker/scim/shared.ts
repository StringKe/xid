// SCIM 端点公共部分:RFC 7644 3.12 错误体、请求体读取、If-Match、后台任务与停用撤销。
// 规格:docs/design/04-enterprise-sso.md 9.1-9.4

import type { AuditQueueMessage, Result, TenantContext, WebhookQueueMessage } from '@xid-kit/types'
import type { Context } from 'hono'
import { revokeUserCredentials } from '../lib/revoke-user-credentials'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { parseScimJsonObject } from './scim-json'

export const SCIM_BULK_MAX_OPERATIONS = 100
export const SCIM_BULK_MAX_PAYLOAD_SIZE = 1_048_576
export const SCIM_JSON_HEADERS = { 'Content-Type': 'application/scim+json' }

type ScimErrorBody = {
  schemas: string[]
  scimType?: string
  detail: string
  status: string
}

type ScimErrorOptions = {
  scimType?: string
  addWwwAuth?: boolean
}

export function scimErrorBody(status: number, detail: string, scimType?: string): ScimErrorBody {
  const body: ScimErrorBody = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    detail,
    status: String(status),
  }
  if (scimType) body.scimType = scimType
  return body
}

export function scimError(
  c: Context<XidHonoEnv>,
  status: number,
  detail: string,
  scimTypeOrOptions?: string | ScimErrorOptions,
): Response {
  const scimType =
    typeof scimTypeOrOptions === 'string' ? scimTypeOrOptions : scimTypeOrOptions?.scimType
  const addWwwAuth =
    typeof scimTypeOrOptions === 'string' ? false : scimTypeOrOptions?.addWwwAuth === true
  const headers: Record<string, string> = { ...SCIM_JSON_HEADERS }
  if (addWwwAuth) headers['WWW-Authenticate'] = 'Bearer'
  return c.json(scimErrorBody(status, detail, scimType), status as 200, headers)
}

export async function readScimJson(
  c: Context<XidHonoEnv>,
): Promise<Result<Record<string, unknown>, Response>> {
  const body = parseScimJsonObject(await c.req.text())
  if (!body) return { ok: false, error: scimError(c, 400, 'Invalid JSON body', 'invalidSyntax') }
  return { ok: true, value: body }
}

export function checkScimPrecondition(
  c: Context<XidHonoEnv>,
  currentVersion: string,
): Response | null {
  const ifMatch = c.req.header('If-Match')
  if (!ifMatch) return null
  if (ifMatch.trim() === '*') return null
  const tags = ifMatch.split(',').map((tag) => tag.trim())
  if (!tags.includes(currentVersion)) return scimError(c, 412, 'Resource version mismatch')
  return null
}

// D1 / SQLite 唯一索引冲突,可能被 Drizzle 包在 cause 链里。
export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.message.includes('UNIQUE constraint failed')) return true
    current = current.cause
  }
  return false
}

// 9.1.2 deprovisioning:D1 失败向上抛出,由调用方返回 503 让 IdP 重试。
export async function revokeAllUserSessions(
  env: Env,
  tenant: TenantContext,
  userId: string,
): Promise<void> {
  await revokeUserCredentials(env, tenant, userId)
}

export function readExecutionContext(
  c: Context<XidHonoEnv> | Env,
): Context<XidHonoEnv>['executionCtx'] | undefined {
  if (!('executionCtx' in c)) return undefined
  try {
    return c.executionCtx
  } catch (error) {
    if (error instanceof Error && error.message === 'This context has no ExecutionContext') {
      return undefined
    }
    throw error
  }
}

export function runScimBackgroundTask(
  c: Context<XidHonoEnv> | Env,
  task: Promise<unknown>,
  failureEvent: string,
): void {
  const executionCtx = readExecutionContext(c)
  if (executionCtx !== undefined) {
    executionCtx.waitUntil(task)
    return
  }
  void task.catch((error: unknown) => logWorkerError(failureEvent, error, { component: 'scim' }))
}

export function emitWebhookAsync(c: Context<XidHonoEnv> | Env, msg: WebhookQueueMessage): void {
  const env = 'env' in c ? c.env : c
  runScimBackgroundTask(c, env.WEBHOOK_QUEUE.send(msg), 'scim.webhook_queue.send_failed')
}

export function emitAuditAsync(c: Context<XidHonoEnv>, msg: AuditQueueMessage): void {
  runScimBackgroundTask(c, c.env.AUDIT_QUEUE.send(msg), 'scim.audit_queue.send_failed')
}
