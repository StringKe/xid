import { createTenantDb, resolveTenantContextByIssuer, schema } from '@xid-kit/db'
import type { AuditQueueMessage, ScimSyncQueueMessage, TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import { isAppError } from '../lib/errors'
import { logWorkerError } from '../lib/safe-log'
import { OutboundScimRequestError } from '../scim/outbound-client'
import { releaseFullSyncClaim } from '../scim/outbound-enqueue'
import type { OutboundScimSyncMessage } from '../scim/outbound-enqueue'
import { executeScimTargetSync, executeScimUserSync } from '../scim/outbound-sync'
import type { SyncSummary } from '../scim/outbound-sync'

const MAX_RETRIES = 5
const MAX_RETRY_DELAY_SECONDS = 86_400
const BASE_RETRY_DELAY_SECONDS = 30

class PermanentScimSyncError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PermanentScimSyncError'
  }
}

function retryDelaySeconds(attempt: number, error: unknown): number {
  if (error instanceof OutboundScimRequestError && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds
  }
  return Math.min(MAX_RETRY_DELAY_SECONDS, BASE_RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempt - 1))
}

function safeFailure(error: unknown): {
  reason: string
  retryable: boolean
  statusCode?: number
  retryAfterSeconds?: number
} {
  if (error instanceof PermanentScimSyncError) {
    return { reason: error.reason, retryable: false }
  }
  if (error instanceof OutboundScimRequestError) {
    return {
      reason: error.statusCode === undefined ? 'network_failure' : 'downstream_http',
      retryable: error.retryable,
      statusCode: error.statusCode,
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }
  if (isAppError(error) && error.code === 'validation_failed') {
    const reason =
      error.meta?.paramName === 'token' ? 'token_missing' : 'target_configuration_invalid'
    return { reason, retryable: false }
  }
  return { reason: 'sync_internal_failure', retryable: true }
}

type RunState = {
  status: 'succeeded' | 'retrying' | 'failed'
  error: string | null
}

// Console 读取的运行状态只存安全的原因码(可带下游 HTTP 状态),不存响应体或 token。
async function recordRunState(
  env: Env,
  body: ScimSyncQueueMessage,
  state: RunState,
): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE scim_targets
       SET last_run_status = ?, last_run_error = ?, last_run_at = ?, updated_at = ?
       WHERE tenant_id = ? AND org_id = ? AND id = ?`,
  )
    .bind(state.status, state.error, now, now, body.tenantId, body.orgId, body.targetId)
    .run()
}

function failureCode(failure: ReturnType<typeof safeFailure>): string {
  return failure.statusCode === undefined
    ? failure.reason
    : `${failure.reason}:${failure.statusCode}`
}

async function resolveQueueTenant(env: Env, message: ScimSyncQueueMessage): Promise<TenantContext> {
  let request: Request
  try {
    const issuerUrl = new URL('/', message.issuer)
    request = new Request(issuerUrl, { headers: { host: issuerUrl.host } })
  } catch {
    throw new PermanentScimSyncError('tenant_issuer_invalid')
  }
  const result = await resolveTenantContextByIssuer(request, env, message.issuer, {
    tenantId: message.tenantId,
  })
  if (!result.ok) {
    throw new PermanentScimSyncError('tenant_not_found')
  }
  return result.value.tenant
}

async function resolveTarget(env: Env, tenant: TenantContext, message: ScimSyncQueueMessage) {
  const target = await createTenantDb(env.DB, tenant)
    .forOrg(message.orgId)
    .scimTargets.findOne(
      and(eq(schema.scimTargets.id, message.targetId), eq(schema.scimTargets.status, 'active')),
    )
  if (!target) throw new PermanentScimSyncError('target_not_found')
  return target
}

function auditMessage(
  body: OutboundScimSyncMessage,
  action: AuditQueueMessage['action'],
  attempt: number,
  payload: Record<string, unknown>,
): AuditQueueMessage {
  return {
    tenantId: body.tenantId,
    orgId: body.orgId,
    action,
    actorId: body.actorId,
    ts: Date.now(),
    payload: {
      // 同一 runId 的续传批次各自重试,游标进入去重键以免审计被合并。
      sourceMessageId: `${body.runId}${body.cursor === undefined ? '' : `:cursor:${body.cursor}`}:attempt:${attempt}:${action}`,
      runId: body.runId,
      targetType: 'scim_target',
      targetId: body.targetId,
      attempt,
      ...payload,
    },
  }
}

// 单用户消息只同步该用户;全量对账每条消息处理一批成员,未完成时以游标入队下一批再 ack,
// 失败重试只重做当前批次。
async function runSync(
  env: Env,
  body: OutboundScimSyncMessage,
  scope: { tenant: TenantContext; target: Awaited<ReturnType<typeof resolveTarget>> },
): Promise<SyncSummary> {
  if (body.userId !== undefined) {
    return executeScimUserSync({ env, ...scope, userId: body.userId })
  }
  if (body.cursor === undefined) await releaseFullSyncClaim(env, scope.tenant, scope.target)
  const summary = await executeScimTargetSync({ env, ...scope, cursor: body.cursor })
  if (summary.nextCursor !== undefined) {
    const next: OutboundScimSyncMessage = { ...body, cursor: summary.nextCursor }
    await env.SCIM_QUEUE.send(next)
  }
  return summary
}

async function processMessage(message: Message<ScimSyncQueueMessage>, env: Env): Promise<void> {
  const body: OutboundScimSyncMessage = message.body
  const attempt = message.attempts
  try {
    if (body.cursor === undefined) {
      await env.AUDIT_QUEUE.send({
        tenantId: body.tenantId,
        orgId: body.orgId,
        action: 'outbound_scim.sync.accepted',
        actorId: body.actorId,
        ts: body.requestedAt,
        payload: {
          sourceMessageId: `${body.runId}:accepted`,
          runId: body.runId,
          targetType: 'scim_target',
          targetId: body.targetId,
          ...(body.userId === undefined ? {} : { userId: body.userId }),
        },
      })
    }
    const tenant = await resolveQueueTenant(env, body)
    const target = await resolveTarget(env, tenant, body)
    const summary = await runSync(env, body, { tenant, target })
    if (summary.nextCursor !== undefined) {
      message.ack()
      return
    }
    await env.AUDIT_QUEUE.send(
      auditMessage(body, 'outbound_scim.sync.succeeded', attempt, {
        provider: summary.provider,
        users: summary.users,
        groups: summary.groups,
        deactivations: summary.deactivations,
      }),
    )
    await recordRunState(env, body, { status: 'succeeded', error: null })
    message.ack()
  } catch (error) {
    const failure = safeFailure(error)
    logWorkerError('outbound_scim.sync.failed', error, {
      component: 'scim-sync',
      operation: failure.reason,
      outcome: failure.retryable ? 'retry_scheduled' : 'terminal',
      queue: 'xid-scim-sync',
      attempt,
      ...(failure.statusCode === undefined ? {} : { status: failure.statusCode }),
    })
    if (!failure.retryable) {
      await env.AUDIT_QUEUE.send(
        auditMessage(body, 'outbound_scim.sync.failed', attempt, {
          reason: failure.reason,
          statusCode: failure.statusCode,
          terminal: true,
        }),
      )
      await recordRunState(env, body, { status: 'failed', error: failureCode(failure) })
      message.ack()
      return
    }

    const delaySeconds = retryDelaySeconds(attempt, error)
    // CF 首次投递计为 attempt 1;max_retries=5 时第 6 次才进死信。
    const terminalAttempt = attempt > MAX_RETRIES
    await env.AUDIT_QUEUE.send(
      auditMessage(
        body,
        terminalAttempt ? 'outbound_scim.sync.failed' : 'outbound_scim.sync.retry_scheduled',
        attempt,
        {
          reason: failure.reason,
          statusCode: failure.statusCode,
          retryAfterSeconds: failure.retryAfterSeconds ?? delaySeconds,
          terminal: terminalAttempt,
        },
      ),
    )
    await recordRunState(env, body, {
      status: terminalAttempt ? 'failed' : 'retrying',
      error: failureCode(failure),
    })
    message.retry({ delaySeconds })
  }
}

export async function handleScimSyncBatch(
  batch: MessageBatch<ScimSyncQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processMessage(message, env)
    } catch {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts, undefined) })
    }
  }
}
