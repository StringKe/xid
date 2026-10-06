// 登录结果审计:成功在会话变为 active 时记一次,失败在凭据类错误码映射响应时记一次。
// 失败事件只带请求路径,不带标识符与失败原因,账号不存在与凭据错误写出同一条记录(枚举防护)。
// 两类事件都经 AUDIT_QUEUE 异步写入,不阻塞登录路径。

import { schema } from '@xid-kit/db'
import { AUTH_LOGIN_FAILED_EVENT, AUTH_LOGIN_SUCCEEDED_EVENT } from '@xid-kit/types'
import type { TenantContext, XidErrorCode } from '@xid-kit/types'
import { eq, gte } from 'drizzle-orm'
import type { Context } from 'hono'
import type { SQL } from 'drizzle-orm'
import { logWorkerError } from './safe-log'
import type { XidHonoEnv } from './types'

const LOGIN_FAILURE_CODES: ReadonlySet<XidErrorCode> = new Set<XidErrorCode>([
  'invalid_credentials',
  'account_locked',
  'account_suspended',
  'account_banned',
])

// 只统计登录入口:/v1/me 改密码等已登录操作也会抛 invalid_credentials,不算登录失败。
const LOGIN_PATH_PREFIXES = ['/auth/', '/sso/'] as const

export const LOGIN_STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

function isLoginPath(pathname: string): boolean {
  return LOGIN_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

export async function sendLoginSucceededAudit(input: {
  env: Env
  tenant: TenantContext
  userId: string
  timestamp: number
}): Promise<void> {
  await input.env.AUDIT_QUEUE.send({
    tenantId: input.tenant.tenantId,
    action: AUTH_LOGIN_SUCCEEDED_EVENT,
    actorId: input.userId,
    ts: input.timestamp,
    payload: {},
  })
}

export function recordLoginFailure(c: Context<XidHonoEnv>, code: XidErrorCode): void {
  if (!LOGIN_FAILURE_CODES.has(code)) return
  const tenant = c.get('tenant')
  if (!tenant?.tenantId) return
  const path = new URL(c.req.url).pathname
  if (!isLoginPath(path)) return
  const logFailure = (error: unknown): void => {
    logWorkerError('auth.login_failure_audit.enqueue_failed', error, { component: 'login-audit' })
  }
  // 审计投递失败不能改变已确定的错误响应。
  const send = Promise.resolve()
    .then(() =>
      c.env.AUDIT_QUEUE.send({
        tenantId: tenant.tenantId,
        action: AUTH_LOGIN_FAILED_EVENT,
        ts: Date.now(),
        payload: { path },
      }),
    )
    .catch(logFailure)
  try {
    c.executionCtx.waitUntil(send)
  } catch {
    void send
  }
}

export function loginOutcomeFilters(now: Date): {
  window: SQL
  succeeded: SQL
  failed: SQL
} {
  return {
    window: gte(
      schema.auditEvents.occurredAt,
      new Date(now.getTime() - LOGIN_STATS_WINDOW_MS).toISOString(),
    ),
    succeeded: eq(schema.auditEvents.eventType, AUTH_LOGIN_SUCCEEDED_EVENT),
    failed: eq(schema.auditEvents.eventType, AUTH_LOGIN_FAILED_EVENT),
  }
}

// 没有登录事件时返回 null,界面显示「无数据」,不把空样本显示成 100%。
export function loginSuccessRate(successes: number, failures: number): number | null {
  const total = successes + failures
  return total === 0 ? null : successes / total
}
