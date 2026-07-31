import type { schema } from '@xid-kit/db'
import { AppError } from '../lib/errors'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
} from '../platform/audit-outbox'

type CustomHostnameRow = typeof schema.customHostnames.$inferSelect

type AuditedMutableField =
  | 'cloudflareHostnameId'
  | 'status'
  | 'hostnameStatus'
  | 'sslStatus'
  | 'ownershipVerificationType'
  | 'ownershipVerificationName'
  | 'ownershipVerificationValue'
  | 'ownershipExpiresAt'
  | 'dcvDelegationRecords'
  | 'validationRecords'
  | 'verificationErrors'
  | 'activatedAt'
  | 'lastPolledAt'
  | 'deletedAt'

export type CustomHostnameAuditedPatch = Partial<Pick<CustomHostnameRow, AuditedMutableField>>

export type PersistCustomHostnameStateInput = {
  row: CustomHostnameRow
  patch: CustomHostnameAuditedPatch
  action: string
  actorId?: string
  now?: number
}

export type ReleaseCustomHostnameInput = {
  row: CustomHostnameRow
  action: string
  actorId?: string
  now?: number
}

function patchedValue<K extends AuditedMutableField>(
  row: CustomHostnameRow,
  patch: CustomHostnameAuditedPatch,
  key: K,
): CustomHostnameRow[K] {
  return patch[key] === undefined ? row[key] : (patch[key] as CustomHostnameRow[K])
}

function liveRowCondition(row: CustomHostnameRow) {
  return {
    sql: `EXISTS (
      SELECT 1
        FROM custom_hostnames
       WHERE tenant_id = ? AND org_id = ? AND id = ? AND updated_at = ? AND status <> 'deleted'
    )`,
    bindings: [row.tenantId, row.orgId, row.id, row.updatedAt.getTime()],
  }
}

export async function persistCustomHostnameStateWithAudit(
  env: Env,
  input: PersistCustomHostnameStateInput,
): Promise<CustomHostnameRow> {
  const now = input.now ?? Date.now()
  const updated: CustomHostnameRow = {
    ...input.row,
    cloudflareHostnameId: patchedValue(input.row, input.patch, 'cloudflareHostnameId'),
    status: patchedValue(input.row, input.patch, 'status'),
    hostnameStatus: patchedValue(input.row, input.patch, 'hostnameStatus'),
    sslStatus: patchedValue(input.row, input.patch, 'sslStatus'),
    ownershipVerificationType: patchedValue(input.row, input.patch, 'ownershipVerificationType'),
    ownershipVerificationName: patchedValue(input.row, input.patch, 'ownershipVerificationName'),
    ownershipVerificationValue: patchedValue(input.row, input.patch, 'ownershipVerificationValue'),
    ownershipExpiresAt: patchedValue(input.row, input.patch, 'ownershipExpiresAt'),
    dcvDelegationRecords: patchedValue(input.row, input.patch, 'dcvDelegationRecords'),
    validationRecords: patchedValue(input.row, input.patch, 'validationRecords'),
    verificationErrors: patchedValue(input.row, input.patch, 'verificationErrors'),
    activatedAt: patchedValue(input.row, input.patch, 'activatedAt'),
    lastPolledAt: patchedValue(input.row, input.patch, 'lastPolledAt'),
    deletedAt: patchedValue(input.row, input.patch, 'deletedAt'),
    updatedAt: new Date(now),
  }
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    env,
    {
      tenantId: input.row.tenantId,
      orgId: input.row.orgId,
      action: input.action,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      payload: {
        targetType: 'custom_hostname',
        targetId: input.row.id,
        status: updated.status,
      },
    },
    liveRowCondition(input.row),
    now,
  )
  const [auditResult, mutationResult] = await env.DB.batch([
    audit.statement,
    env.DB.prepare(
      `UPDATE custom_hostnames
          SET cloudflare_hostname_id = ?, status = ?, hostname_status = ?, ssl_status = ?,
              ownership_verification_type = ?, ownership_verification_name = ?,
              ownership_verification_value = ?, ownership_expires_at = ?,
              dcv_delegation_records = ?, validation_records = ?, verification_errors = ?,
              activated_at = ?, last_polled_at = ?, deleted_at = ?, updated_at = ?
        WHERE tenant_id = ? AND org_id = ? AND id = ? AND updated_at = ?
          AND status <> 'deleted' AND ${audit.mutationGate.sql}`,
    ).bind(
      updated.cloudflareHostnameId,
      updated.status,
      updated.hostnameStatus,
      updated.sslStatus,
      updated.ownershipVerificationType,
      updated.ownershipVerificationName,
      updated.ownershipVerificationValue,
      updated.ownershipExpiresAt?.getTime() ?? null,
      JSON.stringify(updated.dcvDelegationRecords),
      JSON.stringify(updated.validationRecords),
      JSON.stringify(updated.verificationErrors),
      updated.activatedAt?.getTime() ?? null,
      updated.lastPolledAt?.getTime() ?? null,
      updated.deletedAt?.getTime() ?? null,
      now,
      input.row.tenantId,
      input.row.orgId,
      input.row.id,
      input.row.updatedAt.getTime(),
      ...audit.mutationGate.bindings,
    ),
  ])
  if (auditResult?.meta.changes !== 1 || mutationResult?.meta.changes !== 1) {
    throw new AppError('not_found', { httpStatus: 404 })
  }

  // Queue delivery is deliberately after the atomic D1 commit. A failed immediate send leaves the
  // durable outbox pending for Cron redelivery and must not turn a committed hostname mutation into
  // an apparent request failure.
  await enqueuePersistedPlatformAudit(env, audit)
  return updated
}

export async function releaseCustomHostnameWithAudit(
  env: Env,
  input: ReleaseCustomHostnameInput,
): Promise<void> {
  const now = input.now ?? Date.now()
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    env,
    {
      tenantId: input.row.tenantId,
      orgId: input.row.orgId,
      action: input.action,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      payload: {
        targetType: 'custom_hostname',
        targetId: input.row.id,
        status: 'released',
      },
    },
    liveRowCondition(input.row),
    now,
  )
  const [auditResult, mutationResult] = await env.DB.batch([
    audit.statement,
    env.DB.prepare(
      `DELETE FROM custom_hostnames
        WHERE tenant_id = ? AND org_id = ? AND id = ? AND updated_at = ?
          AND status <> 'deleted' AND ${audit.mutationGate.sql}`,
    ).bind(
      input.row.tenantId,
      input.row.orgId,
      input.row.id,
      input.row.updatedAt.getTime(),
      ...audit.mutationGate.bindings,
    ),
  ])
  if (auditResult?.meta.changes !== 1 || mutationResult?.meta.changes !== 1) {
    throw new AppError('not_found', { httpStatus: 404 })
  }

  await enqueuePersistedPlatformAudit(env, audit)
}
