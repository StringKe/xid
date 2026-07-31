import { schema } from '@xid-kit/db'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { complianceArtifactResponse } from './compliance-artifact'
import { AppError } from './lib/errors'
import { createPersistedId, PERSISTED_ID_PREFIXES } from './lib/persisted-id'
import type { XidHonoEnv } from './lib/types'
import { requireOrgManager } from './v1/shared'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
} from './platform/audit-outbox'
import { managementDb } from './platform/shared'

const app = new Hono<XidHonoEnv>()
const DPA_DOCUMENT_TYPE = 'dpa'
export const CURRENT_VISIBLE_SOURCE_EXISTS = `EXISTS (
  SELECT 1
  FROM compliance_documents AS source_document
  WHERE source_document.id = ?
    AND source_document.status = 'available'
    AND source_document.storage_key = ?
    AND source_document.checksum = ?
    AND (source_document.tenant_id IS NULL OR source_document.tenant_id = ?)
)`

export function currentVisibleSourceBindings(
  source: ComplianceDocumentRow,
  tenantId: string,
): readonly [string, string | null, string | null, string] {
  return [source.id, source.storageKey, source.checksum, tenantId]
}

export type ComplianceDocumentRow = typeof schema.complianceDocuments.$inferSelect

export function prepareDpaAcceptanceInsert(
  env: Env,
  accepted: ComplianceDocumentRow,
  source: ComplianceDocumentRow,
  options:
    | string
    | {
        tenantId: string
        auditGate?: { sql: string; bindings: readonly unknown[] }
      },
): D1PreparedStatement {
  const tenantId = typeof options === 'string' ? options : options.tenantId
  const auditGate = typeof options === 'string' ? undefined : options.auditGate
  return env.DB.prepare(
    `INSERT INTO compliance_documents (
       id, tenant_id, document_type, title, status, storage_key, checksum, version,
       accepted_by, accepted_at, generated_by, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${CURRENT_VISIBLE_SOURCE_EXISTS}
       ${auditGate ? `AND ${auditGate.sql}` : ''}`,
  ).bind(
    accepted.id,
    accepted.tenantId,
    accepted.documentType,
    accepted.title,
    accepted.storageKey,
    accepted.checksum,
    accepted.version,
    accepted.acceptedBy,
    accepted.acceptedAt?.getTime() ?? null,
    accepted.generatedBy,
    accepted.createdAt.getTime(),
    accepted.updatedAt.getTime(),
    source.id,
    source.storageKey,
    source.checksum,
    tenantId,
    ...(auditGate?.bindings ?? []),
  )
}

function mapComplianceDocument(row: ComplianceDocumentRow) {
  return {
    id: row.id,
    documentType: row.documentType,
    title: row.title,
    version: row.version,
    status: row.status,
    checksum: row.checksum ?? null,
    acceptedBy: row.acceptedBy ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    artifactUrl:
      row.storageKey && row.checksum
        ? `/v1/compliance/documents/${encodeURIComponent(row.id)}/artifact`
        : null,
  }
}

async function listAvailableDocuments(
  env: Env,
  tenantId: string,
): Promise<ComplianceDocumentRow[]> {
  const rows = await managementDb(env)
    .select()
    .from(schema.complianceDocuments)
    .where(
      and(
        eq(schema.complianceDocuments.status, 'available'),
        or(
          isNull(schema.complianceDocuments.tenantId),
          eq(schema.complianceDocuments.tenantId, tenantId),
        ),
      ),
    )
    .orderBy(
      desc(schema.complianceDocuments.updatedAt),
      desc(schema.complianceDocuments.createdAt),
      desc(schema.complianceDocuments.id),
    )
  const selected = new Map<string, ComplianceDocumentRow>()
  for (const row of rows) {
    const key = `${row.documentType}:${row.version}`
    const current = selected.get(key)
    if (!current || (current.tenantId === null && row.tenantId === tenantId)) {
      selected.set(key, row)
    }
  }
  return [...selected.values()]
}

async function findVisibleDocument(
  env: Env,
  tenantId: string,
  id: string,
): Promise<ComplianceDocumentRow | undefined> {
  const rows = await managementDb(env)
    .select()
    .from(schema.complianceDocuments)
    .where(
      and(
        eq(schema.complianceDocuments.id, id),
        eq(schema.complianceDocuments.status, 'available'),
        or(
          isNull(schema.complianceDocuments.tenantId),
          eq(schema.complianceDocuments.tenantId, tenantId),
        ),
      ),
    )
    .limit(1)
  return rows[0]
}

async function findTenantDocumentVersion(
  env: Env,
  tenantId: string,
  documentType: string,
  version: string,
): Promise<ComplianceDocumentRow | undefined> {
  const rows = await managementDb(env)
    .select()
    .from(schema.complianceDocuments)
    .where(
      and(
        eq(schema.complianceDocuments.tenantId, tenantId),
        eq(schema.complianceDocuments.documentType, documentType),
        eq(schema.complianceDocuments.version, version),
      ),
    )
    .limit(1)
  return rows[0]
}

export async function dpaAcceptanceAuditId(
  tenantId: string,
  documentType: string,
  version: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${tenantId}\u0000${documentType}\u0000${version}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const suffix = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 21)
  return `${PERSISTED_ID_PREFIXES.platformAudit}${suffix}`
}

app.get('/documents', async (c) => {
  const tenant = c.get('tenant')
  await requireOrgManager(c, tenant.tenantId)
  const rows = await listAvailableDocuments(c.env, tenant.tenantId)
  return c.json(rows.map(mapComplianceDocument))
})

app.get('/documents/:id/artifact', async (c) => {
  const tenant = c.get('tenant')
  await requireOrgManager(c, tenant.tenantId)
  const document = await findVisibleDocument(c.env, tenant.tenantId, c.req.param('id'))
  if (!document) throw new AppError('not_found', { httpStatus: 404 })
  return complianceArtifactResponse(c.env, document)
})

app.post('/documents/:id/accept', async (c) => {
  const tenant = c.get('tenant')
  const { session } = await requireOrgManager(c, tenant.tenantId)
  const source = await findVisibleDocument(c.env, tenant.tenantId, c.req.param('id'))
  if (!source) throw new AppError('not_found', { httpStatus: 404 })
  if (source.documentType !== DPA_DOCUMENT_TYPE) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'documentType' },
    })
  }
  if (!source.storageKey || !source.checksum) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  const tenantVersion = await findTenantDocumentVersion(
    c.env,
    tenant.tenantId,
    source.documentType,
    source.version,
  )
  if (tenantVersion?.acceptedAt) return c.json(mapComplianceDocument(tenantVersion))

  const now = new Date()
  const accepted: ComplianceDocumentRow = tenantVersion
    ? {
        ...tenantVersion,
        title: source.title,
        status: 'available',
        storageKey: source.storageKey,
        checksum: source.checksum,
        acceptedBy: session.userId,
        acceptedAt: now,
        updatedAt: now,
      }
    : {
        id: createPersistedId('complianceDocument'),
        tenantId: tenant.tenantId,
        documentType: source.documentType,
        title: source.title,
        status: 'available',
        storageKey: source.storageKey,
        checksum: source.checksum,
        version: source.version,
        acceptedBy: session.userId,
        acceptedAt: now,
        generatedBy: source.id,
        createdAt: now,
        updatedAt: now,
      }
  const acceptanceCondition = tenantVersion
    ? {
        sql: `EXISTS (
          SELECT 1
            FROM compliance_documents AS acceptance_target
           WHERE acceptance_target.id = ?
             AND acceptance_target.tenant_id = ?
             AND acceptance_target.accepted_at IS NULL
             AND ${CURRENT_VISIBLE_SOURCE_EXISTS}
        )`,
        bindings: [
          accepted.id,
          tenant.tenantId,
          ...currentVisibleSourceBindings(source, tenant.tenantId),
        ],
      }
    : {
        sql: `${CURRENT_VISIBLE_SOURCE_EXISTS}
          AND NOT EXISTS (
            SELECT 1
              FROM compliance_documents AS existing_acceptance
             WHERE existing_acceptance.tenant_id = ?
               AND existing_acceptance.document_type = ?
               AND existing_acceptance.version = ?
          )`,
        bindings: [
          ...currentVisibleSourceBindings(source, tenant.tenantId),
          tenant.tenantId,
          source.documentType,
          source.version,
        ],
      }
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      id: await dpaAcceptanceAuditId(tenant.tenantId, source.documentType, source.version),
      tenantId: tenant.tenantId,
      orgId: tenant.tenantId,
      action: 'compliance.dpa.accepted',
      actorId: session.userId,
      payload: {
        targetType: 'compliance_document',
        targetId: accepted.id,
        sourceDocumentId: source.id,
        documentType: source.documentType,
        version: source.version,
        checksum: source.checksum,
      },
    },
    acceptanceCondition,
    now.getTime(),
  )
  const mutation = tenantVersion
    ? c.env.DB.prepare(
        `UPDATE compliance_documents
         SET title = ?, status = 'available', storage_key = ?, checksum = ?,
             accepted_by = ?, accepted_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL
           AND ${CURRENT_VISIBLE_SOURCE_EXISTS}
           AND ${audit.mutationGate.sql}`,
      ).bind(
        accepted.title,
        accepted.storageKey,
        accepted.checksum,
        accepted.acceptedBy,
        accepted.acceptedAt?.getTime() ?? null,
        accepted.updatedAt.getTime(),
        accepted.id,
        tenant.tenantId,
        source.id,
        source.storageKey,
        source.checksum,
        tenant.tenantId,
        ...audit.mutationGate.bindings,
      )
    : prepareDpaAcceptanceInsert(c.env, accepted, source, {
        tenantId: tenant.tenantId,
        auditGate: audit.mutationGate,
      })
  let auditResult: D1Result<unknown> | undefined
  let mutationResult: D1Result<unknown> | undefined
  try {
    const results = await c.env.DB.batch([audit.statement, mutation])
    auditResult = results[0]
    mutationResult = results[1]
  } catch (error) {
    const concurrent = await findTenantDocumentVersion(
      c.env,
      tenant.tenantId,
      source.documentType,
      source.version,
    )
    if (concurrent?.acceptedAt) return c.json(mapComplianceDocument(concurrent))
    throw error
  }
  if (auditResult?.meta.changes !== 1 || mutationResult?.meta.changes !== 1) {
    const concurrent = await findTenantDocumentVersion(
      c.env,
      tenant.tenantId,
      source.documentType,
      source.version,
    )
    if (concurrent?.acceptedAt) return c.json(mapComplianceDocument(concurrent))
    throw new AppError('conflict', { httpStatus: 409 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(mapComplianceDocument(accepted), 201)
})

export function registerComplianceRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/compliance', app)
}
