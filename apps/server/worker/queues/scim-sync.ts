import { createTenantDb, resolveTenantContextByIssuer, schema } from '@xid-kit/db'
import type { AuditQueueMessage, ScimSyncQueueMessage, TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import { isAppError } from '../lib/errors'
import { logWorkerError } from '../lib/safe-log'
import { executeScimTargetSync, OutboundScimRequestError } from '../scim/outbound'

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
    return { reason: 'target_configuration_invalid', retryable: false }
  }
  return { reason: 'sync_internal_failure', retryable: true }
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
  body: ScimSyncQueueMessage,
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
      sourceMessageId: `${body.runId}:attempt:${attempt}:${action}`,
      runId: body.runId,
      targetType: 'scim_target',
      targetId: body.targetId,
      attempt,
      ...payload,
    },
  }
}

async function processMessage(message: Message<ScimSyncQueueMessage>, env: Env): Promise<void> {
  const body = message.body
  const attempt = message.attempts
  try {
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
      },
    })
    const tenant = await resolveQueueTenant(env, body)
    const target = await resolveTarget(env, tenant, body)
    const summary = await executeScimTargetSync({ env, tenant, target })
    await env.AUDIT_QUEUE.send(
      auditMessage(body, 'outbound_scim.sync.succeeded', attempt, {
        provider: summary.provider,
        users: summary.users,
        groups: summary.groups,
        deactivations: summary.deactivations,
      }),
    )
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
