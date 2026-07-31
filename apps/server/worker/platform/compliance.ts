import { schema } from '@xid-kit/db'
import { and, count, desc, eq, isNull, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import {
  complianceArtifactResponse,
  isComplianceChecksum,
  isComplianceStorageKey,
} from '../compliance-artifact'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
  preparePlatformAuditOutboxInsert,
} from './audit-outbox'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()
const DOCUMENT_STATUSES = ['draft', 'available', 'retired'] as const
const CURSOR_SEPARATOR = '|'
const nullableNonEmptyString = v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1)))

const createDocumentSchema = v.object({
  tenantId: v.optional(nullableNonEmptyString, null),
  documentType: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(/^[a-z][a-z0-9_-]*$/u),
  ),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
  status: v.picklist(DOCUMENT_STATUSES),
  storageKey: v.optional(nullableNonEmptyString, null),
  checksum: v.optional(nullableNonEmptyString, null),
  version: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
})

const patchDocumentSchema = v.partial(createDocumentSchema)

type ComplianceDocumentRow = typeof schema.complianceDocuments.$inferSelect
type ComplianceDocumentInput = v.InferOutput<typeof createDocumentSchema>

const NO_ACCEPTED_DEPENDENT_DOCUMENT = `NOT EXISTS (
  SELECT 1
  FROM compliance_documents AS accepted_copy
  WHERE accepted_copy.generated_by = compliance_documents.id
    AND accepted_copy.accepted_at IS NOT NULL
)`

export function prepareComplianceDocumentDelete(env: Env, documentId: string): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM compliance_documents
     WHERE id = ? AND accepted_at IS NULL
       AND ${NO_ACCEPTED_DEPENDENT_DOCUMENT}`,
  ).bind(documentId)
}

function mapComplianceDocument(row: ComplianceDocumentRow) {
  return {
    id: row.id,
    tenantId: row.tenantId ?? null,
    documentType: row.documentType,
    title: row.title,
    status: row.status,
    storageKey: row.storageKey ?? null,
    checksum: row.checksum ?? null,
    version: row.version,
    acceptedBy: row.acceptedBy ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    generatedBy: row.generatedBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    artifactUrl:
      row.storageKey && row.checksum
        ? `/v1/platform/compliance-documents/${encodeURIComponent(row.id)}/artifact`
        : null,
  }
}

function assertArtifactPair(storageKey: string | null, checksum: string | null): void {
  if ((storageKey === null) !== (checksum === null)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: storageKey === null ? 'storageKey' : 'checksum' },
    })
  }
  if (storageKey && !isComplianceStorageKey(storageKey)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'storageKey' },
    })
  }
  if (checksum && !isComplianceChecksum(checksum)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'checksum' },
    })
  }
}

async function assertTenant(env: Env, tenantId: string | null): Promise<void> {
  if (!tenantId) return
  const [tenant] = await managementDb(env)
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.id, tenantId),
        eq(schema.organizations.tenantId, tenantId),
        isNull(schema.organizations.parentOrgId),
      ),
    )
    .limit(1)
  if (!tenant) throw new AppError('not_found', { httpStatus: 404 })
}

function decodeDocumentCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = decodeCursor(cursor)
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR)
  if (separatorIndex === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  const createdAt = new Date(Number(decoded.slice(0, separatorIndex)))
  const id = decoded.slice(separatorIndex + 1)
  if (!Number.isFinite(createdAt.getTime()) || id.length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  return { createdAt, id }
}

function afterDocumentCursor(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const decoded = decodeDocumentCursor(cursor)
  return or(
    lt(schema.complianceDocuments.createdAt, decoded.createdAt),
    and(
      eq(schema.complianceDocuments.createdAt, decoded.createdAt),
      lt(schema.complianceDocuments.id, decoded.id),
    ),
  )
}

function encodeDocumentCursor(row: ComplianceDocumentRow): string {
  return encodeCursor(`${row.createdAt.getTime()}${CURSOR_SEPARATOR}${row.id}`)
}

async function findDocument(env: Env, id: string): Promise<ComplianceDocumentRow | undefined> {
  const rows = await managementDb(env)
    .select()
    .from(schema.complianceDocuments)
    .where(eq(schema.complianceDocuments.id, id))
    .limit(1)
  return rows[0]
}

function normalizeInput(input: ComplianceDocumentInput): ComplianceDocumentInput {
  const normalized = {
    ...input,
    tenantId: input.tenantId ?? null,
    storageKey: input.storageKey ?? null,
    checksum: input.checksum ?? null,
  }
  assertArtifactPair(normalized.storageKey, normalized.checksum)
  return normalized
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 30)
  const after = afterDocumentCursor(cursor)
  const rows = await db
    .select()
    .from(schema.complianceDocuments)
    .where(after)
    .orderBy(desc(schema.complianceDocuments.createdAt), desc(schema.complianceDocuments.id))
    .limit(limit + 1)
  const [totalRow] = await db.select({ value: count() }).from(schema.complianceDocuments)
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows.at(-1)
  return c.json({
    data: pageRows.map(mapComplianceDocument),
    nextCursor: hasMore && last ? encodeDocumentCursor(last) : null,
    total: totalRow?.value ?? 0,
  })
})

app.get('/:id/artifact', async (c) => {
  await requireInstanceManager(c)
  const document = await findDocument(c.env, c.req.param('id'))
  if (!document) throw new AppError('not_found', { httpStatus: 404 })
  return complianceArtifactResponse(c.env, document)
})

app.post('/', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const input = normalizeInput(validateBody(createDocumentSchema, json.value))
  await assertTenant(c.env, input.tenantId)
  const now = new Date()
  const row: ComplianceDocumentRow = {
    id: createPersistedId('complianceDocument'),
    tenantId: input.tenantId,
    documentType: input.documentType,
    title: input.title,
    status: input.status,
    storageKey: input.storageKey,
    checksum: input.checksum,
    version: input.version,
    acceptedBy: null,
    acceptedAt: null,
    generatedBy: session.userId,
    createdAt: now,
    updatedAt: now,
  }
  const audit = preparePlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: row.tenantId ?? 'platform',
      action: 'platform.compliance_document.created',
      actorId: session.userId,
      payload: {
        targetType: 'compliance_document',
        targetId: row.id,
        documentType: row.documentType,
        version: row.version,
        tenantScoped: row.tenantId !== null,
        hasArtifact: row.storageKey !== null,
      },
    },
    now.getTime(),
  )
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO compliance_documents (
         id, tenant_id, document_type, title, status, storage_key, checksum, version,
         accepted_by, accepted_at, generated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).bind(
      row.id,
      row.tenantId,
      row.documentType,
      row.title,
      row.status,
      row.storageKey,
      row.checksum,
      row.version,
      row.generatedBy,
      row.createdAt.getTime(),
      row.updatedAt.getTime(),
    ),
    audit.statement,
  ])
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(mapComplianceDocument(row), 201)
})

app.patch('/:id', async (c) => {
  const session = await requireInstanceManager(c)
  const existing = await findDocument(c.env, c.req.param('id'))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  if (existing.acceptedAt) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const patch = validateBody(patchDocumentSchema, json.value)
  if (Object.keys(patch).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  const input = normalizeInput({
    tenantId: patch.tenantId === undefined ? existing.tenantId : patch.tenantId,
    documentType: patch.documentType ?? existing.documentType,
    title: patch.title ?? existing.title,
    status:
      patch.status ??
      (DOCUMENT_STATUSES.includes(existing.status as (typeof DOCUMENT_STATUSES)[number])
        ? (existing.status as (typeof DOCUMENT_STATUSES)[number])
        : 'draft'),
    storageKey: patch.storageKey === undefined ? existing.storageKey : patch.storageKey,
    checksum: patch.checksum === undefined ? existing.checksum : patch.checksum,
    version: patch.version ?? existing.version,
  })
  await assertTenant(c.env, input.tenantId)
  const now = new Date()
  const updated: ComplianceDocumentRow = {
    ...existing,
    ...input,
    tenantId: input.tenantId,
    storageKey: input.storageKey,
    checksum: input.checksum,
    generatedBy: session.userId,
    updatedAt: now,
  }
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: updated.tenantId ?? 'platform',
      action: 'platform.compliance_document.updated',
      actorId: session.userId,
      payload: {
        targetType: 'compliance_document',
        targetId: updated.id,
        documentType: updated.documentType,
        version: updated.version,
        tenantScoped: updated.tenantId !== null,
        hasArtifact: updated.storageKey !== null,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1
          FROM compliance_documents
         WHERE id = ? AND accepted_at IS NULL AND updated_at = ?
           AND ${NO_ACCEPTED_DEPENDENT_DOCUMENT}
      )`,
      bindings: [updated.id, existing.updatedAt.getTime()],
    },
    now.getTime(),
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `UPDATE compliance_documents
       SET tenant_id = ?, document_type = ?, title = ?, status = ?, storage_key = ?,
           checksum = ?, version = ?, generated_by = ?, updated_at = ?
       WHERE id = ? AND accepted_at IS NULL AND updated_at = ?
         AND ${NO_ACCEPTED_DEPENDENT_DOCUMENT}
         AND ${audit.mutationGate.sql}`,
    ).bind(
      updated.tenantId,
      updated.documentType,
      updated.title,
      updated.status,
      updated.storageKey,
      updated.checksum,
      updated.version,
      updated.generatedBy,
      updated.updatedAt.getTime(),
      updated.id,
      existing.updatedAt.getTime(),
      ...audit.mutationGate.bindings,
    ),
  ])
  if (auditResult?.meta.changes !== 1 || mutation?.meta.changes !== 1) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(mapComplianceDocument(updated))
})

app.delete('/:id', async (c) => {
  const session = await requireInstanceManager(c)
  const existing = await findDocument(c.env, c.req.param('id'))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  if (existing.acceptedAt) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  const now = Date.now()
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: existing.tenantId ?? 'platform',
      action: 'platform.compliance_document.deleted',
      actorId: session.userId,
      payload: {
        targetType: 'compliance_document',
        targetId: existing.id,
        documentType: existing.documentType,
        version: existing.version,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1
          FROM compliance_documents
         WHERE id = ? AND accepted_at IS NULL AND updated_at = ?
           AND ${NO_ACCEPTED_DEPENDENT_DOCUMENT}
      )`,
      bindings: [existing.id, existing.updatedAt.getTime()],
    },
    now,
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `DELETE FROM compliance_documents
        WHERE id = ? AND accepted_at IS NULL AND updated_at = ?
          AND ${NO_ACCEPTED_DEPENDENT_DOCUMENT}
          AND ${audit.mutationGate.sql}`,
    ).bind(existing.id, existing.updatedAt.getTime(), ...audit.mutationGate.bindings),
  ])
  if (auditResult?.meta.changes !== 1 || mutation?.meta.changes !== 1) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json({ deleted: true as const })
})

export function registerPlatformComplianceRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/compliance-documents', app)
}
