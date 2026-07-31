import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { persistCustomHostnameStateWithAudit } from '../custom-hostnames/audited-state'
import { customHostnameStatePatch } from '../custom-hostnames/state'
import {
  CUSTOM_HOSTNAME_OWNERSHIP_TTL_MS,
  CloudflareCustomHostnameError,
  createCloudflareCustomHostnamesClient,
  normalizeCustomHostname,
  type CloudflareCustomHostnameDetails,
  type CloudflareCustomHostnamesClientLike,
  type CloudflareForSaasEnv,
} from '../lib/cloudflare-custom-hostnames'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { readJsonBody, validateBody } from '../lib/validate'
import type { XidHonoEnv } from '../lib/types'
import {
  idAfterCursor,
  paginate,
  parsePagination,
  requireApiKeyOrOrgManager,
  type OrgScopedAuth,
} from './shared'

const createBodySchema = v.object({
  hostname: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
})

type CustomHostnameRow = typeof schema.customHostnames.$inferSelect

export type CustomHostnamesClientFactory = (env: Env) => CloudflareCustomHostnamesClientLike

export type RegisterCustomHostnamesOptions = {
  clientFactory?: CustomHostnamesClientFactory
}

function defaultClientFactory(env: Env): CloudflareCustomHostnamesClientLike {
  return createCloudflareCustomHostnamesClient(env as CloudflareForSaasEnv)
}

function primaryDomain(c: Context<XidHonoEnv>): string {
  const tenant = c.get('tenant')
  const configured = tenant.resolution?.primaryDomain
  if (configured) return configured
  try {
    return new URL(tenant.issuer).hostname
  } catch (error) {
    throw new AppError('service_unavailable', { cause: error })
  }
}

function mapCloudflareError(error: unknown, paramName?: string): AppError {
  if (
    error instanceof CloudflareCustomHostnameError &&
    error.code === 'cloudflare_for_saas_invalid_hostname'
  ) {
    return new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: paramName ?? 'hostname' },
      cause: error,
    })
  }
  return new AppError('service_unavailable', { httpStatus: 503, cause: error })
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (/unique constraint/iu.test(error.message)) return true
  return error.cause !== undefined && isUniqueConstraintError(error.cause)
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null
}

function toResponse(row: CustomHostnameRow) {
  const certificateValidation = row.validationRecords.flatMap((record) => {
    const records: Array<{ type: 'TXT' | 'CNAME'; name: string; value: string }> = []
    if (record.txtName && record.txtValue) {
      records.push({ type: 'TXT', name: record.txtName, value: record.txtValue })
    }
    if (record.cname && record.cnameTarget) {
      records.push({ type: 'CNAME', name: record.cname, value: record.cnameTarget })
    }
    return records
  })
  return {
    id: row.id,
    organization_id: row.orgId,
    hostname: row.hostname,
    status: row.status,
    hostname_status: row.hostnameStatus,
    ssl_status: row.sslStatus,
    ownership_expires_at: toIso(row.ownershipExpiresAt),
    activated_at: toIso(row.activatedAt),
    last_polled_at: toIso(row.lastPolledAt),
    requires_passkey_reregistration: row.requiresPasskeyReregistration,
    dns_records: {
      ownership:
        row.ownershipVerificationName && row.ownershipVerificationValue
          ? {
              type: (row.ownershipVerificationType ?? 'txt').toUpperCase(),
              name: row.ownershipVerificationName,
              value: row.ownershipVerificationValue,
            }
          : null,
      dcv_delegation: row.dcvDelegationRecords.map((record) => ({
        type: 'CNAME',
        name: record.cname,
        value: record.cnameTarget,
      })),
      certificate_validation: certificateValidation,
      traffic: {
        type: 'CNAME',
        name: row.hostname,
        value: row.trafficCnameTarget,
      },
    },
    verification_errors: row.verificationErrors,
  }
}

function auditActorId(auth: OrgScopedAuth): string {
  return auth.kind === 'org_console' ? auth.session.userId : auth.apiKeyId
}

async function restoreReservation(
  db: ReturnType<typeof createTenantDb>,
  row: CustomHostnameRow,
  wasDeleted: boolean,
): Promise<void> {
  if (wasDeleted) {
    await db.customHostnames.update(
      {
        status: 'deleted',
        cloudflareHostnameId: null,
        hostnameStatus: 'deleted',
        sslStatus: null,
        ownershipVerificationType: null,
        ownershipVerificationName: null,
        ownershipVerificationValue: null,
        ownershipExpiresAt: null,
        dcvDelegationRecords: [],
        validationRecords: [],
        verificationErrors: [],
        activatedAt: null,
        lastPolledAt: null,
        deletedAt: row.deletedAt ?? new Date(),
      },
      eq(schema.customHostnames.id, row.id),
    )
    return
  }
  await db.customHostnames.hardDelete(eq(schema.customHostnames.id, row.id))
}

function appFor(options: RegisterCustomHostnamesOptions): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  const clientFactory = options.clientFactory ?? defaultClientFactory

  app.get('/:orgId/custom-hostnames', async (c) => {
    const orgId = c.req.param('orgId')
    await requireApiKeyOrOrgManager(c, orgId, 'custom_hostnames:read')
    const db = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
    const { limit, cursor } = parsePagination(c)
    const after = idAfterCursor(schema.customHostnames.id, cursor)
    const visible = ne(schema.customHostnames.status, 'deleted')
    const rows = await db.customHostnames.findMany(after ? and(visible, after) : visible, {
      orderBy: asc(schema.customHostnames.id),
      limit: limit + 1,
    })
    return c.json(paginate(rows.map(toResponse), (row) => row.id, limit))
  })

  app.get('/:orgId/custom-hostnames/:customHostnameId', async (c) => {
    const orgId = c.req.param('orgId')
    await requireApiKeyOrOrgManager(c, orgId, 'custom_hostnames:read')
    const db = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
    const row = await db.customHostnames.findOne(
      and(
        eq(schema.customHostnames.id, c.req.param('customHostnameId')),
        ne(schema.customHostnames.status, 'deleted'),
      ),
    )
    if (!row) throw new AppError('not_found', { httpStatus: 404 })
    return c.json(toResponse(row))
  })

  app.post('/:orgId/custom-hostnames', async (c) => {
    const orgId = c.req.param('orgId')
    const auth = await requireApiKeyOrOrgManager(c, orgId, 'custom_hostnames:write')
    const tenant = c.get('tenant')
    if (!tenant.instanceId) throw new AppError('service_unavailable', { httpStatus: 503 })

    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(createBodySchema, json.value)
    let hostname: string
    try {
      hostname = normalizeCustomHostname(body.hostname, primaryDomain(c))
    } catch (error) {
      throw mapCloudflareError(error, 'hostname')
    }

    let client: CloudflareCustomHostnamesClientLike
    let trafficCnameTarget: string
    try {
      client = clientFactory(c.env)
      trafficCnameTarget = await client.trafficCnameTarget()
    } catch (error) {
      throw mapCloudflareError(error)
    }

    const db = createTenantDb(c.env.DB, tenant)
    const orgDb = db.forOrg(orgId)
    const existing = await orgDb.customHostnames.findOne(
      eq(schema.customHostnames.hostname, hostname),
    )
    const wasDeleted = existing?.status === 'deleted'
    const wasRecoverableFailure =
      existing?.status === 'provisioning_failed' && existing.cloudflareHostnameId === null
    if (existing && !wasDeleted && !wasRecoverableFailure) {
      throw new AppError('already_exists', {
        httpStatus: 409,
        meta: { paramName: 'hostname' },
      })
    }

    const ownershipExpiresAt =
      wasRecoverableFailure && existing.ownershipExpiresAt
        ? existing.ownershipExpiresAt
        : new Date(Date.now() + CUSTOM_HOSTNAME_OWNERSHIP_TTL_MS)
    let reservation: CustomHostnameRow
    try {
      reservation =
        wasDeleted || wasRecoverableFailure
          ? (
              await orgDb.customHostnames.update(
                {
                  cloudflareHostnameId: null,
                  status: 'provisioning',
                  hostnameStatus: 'pending',
                  sslStatus: null,
                  ownershipVerificationType: null,
                  ownershipVerificationName: null,
                  ownershipVerificationValue: null,
                  ownershipExpiresAt,
                  dcvDelegationRecords: [],
                  validationRecords: [],
                  trafficCnameTarget,
                  verificationErrors: [],
                  activatedAt: null,
                  lastPolledAt: null,
                  deletedAt: null,
                },
                eq(schema.customHostnames.id, existing.id),
              )
            )[0]!
          : await orgDb.customHostnames.insert({
              id: createPersistedId('customHostname'),
              tenantId: tenant.tenantId,
              orgId,
              instanceId: tenant.instanceId,
              hostname,
              trafficCnameTarget,
              ownershipExpiresAt,
            })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError('already_exists', {
          httpStatus: 409,
          meta: { paramName: 'hostname' },
        })
      }
      throw error
    }

    let remote: CloudflareCustomHostnameDetails
    try {
      remote =
        (wasRecoverableFailure ? await client.findByHostname(hostname) : null) ??
        (await client.create(hostname))
    } catch (createError) {
      let recovered: CloudflareCustomHostnameDetails | null
      try {
        recovered = await client.findByHostname(hostname)
      } catch (reconcileError) {
        await db.customHostnames.update(
          { status: 'provisioning_failed' },
          eq(schema.customHostnames.id, reservation.id),
        )
        throw new AppError('service_unavailable', {
          httpStatus: 503,
          cause: new AggregateError([createError, reconcileError]),
        })
      }
      if (recovered) {
        remote = recovered
      } else {
        await restoreReservation(db, reservation, wasDeleted)
        throw mapCloudflareError(createError)
      }
    }

    if (
      remote.hostname !== hostname ||
      (remote.ownershipVerification && remote.ownershipVerification.type.toLowerCase() !== 'txt')
    ) {
      try {
        await client.delete(remote.id)
        await restoreReservation(db, reservation, wasDeleted)
      } catch (error) {
        await db.customHostnames.update(
          {
            cloudflareHostnameId: remote.id,
            status: 'deletion_failed',
          },
          eq(schema.customHostnames.id, reservation.id),
        )
        throw mapCloudflareError(error)
      }
      throw new AppError('service_unavailable', { httpStatus: 503 })
    }

    let updated: CustomHostnameRow | undefined
    try {
      updated = await persistCustomHostnameStateWithAudit(c.env, {
        row: reservation,
        patch: customHostnameStatePatch(remote, reservation),
        action: 'custom_hostname.created',
        actorId: auditActorId(auth),
      })
    } catch (dbError) {
      try {
        await client.delete(remote.id)
        await restoreReservation(db, reservation, wasDeleted)
      } catch (deleteError) {
        await db.customHostnames.update(
          {
            cloudflareHostnameId: remote.id,
            status: 'deletion_failed',
          },
          eq(schema.customHostnames.id, reservation.id),
        )
        throw new AppError('service_unavailable', {
          httpStatus: 503,
          cause: new AggregateError([dbError, deleteError]),
        })
      }
      throw new AppError('internal_error', { cause: dbError })
    }
    if (!updated) throw new AppError('internal_error')
    return c.json(toResponse(updated), 201)
  })

  app.post('/:orgId/custom-hostnames/:customHostnameId/refresh', async (c) => {
    const orgId = c.req.param('orgId')
    const auth = await requireApiKeyOrOrgManager(c, orgId, 'custom_hostnames:write')
    const db = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
    const row = await db.customHostnames.findOne(
      and(
        eq(schema.customHostnames.id, c.req.param('customHostnameId')),
        ne(schema.customHostnames.status, 'deleted'),
      ),
    )
    if (!row || !row.cloudflareHostnameId) throw new AppError('not_found', { httpStatus: 404 })

    try {
      const remote = await clientFactory(c.env).get(row.cloudflareHostnameId)
      if (remote.id !== row.cloudflareHostnameId || remote.hostname !== row.hostname) {
        throw new CloudflareCustomHostnameError('cloudflare_for_saas_invalid_response')
      }
      const updated = await persistCustomHostnameStateWithAudit(c.env, {
        row,
        patch: customHostnameStatePatch(remote, row),
        action: 'custom_hostname.refreshed',
        actorId: auditActorId(auth),
      })
      return c.json(toResponse(updated))
    } catch (error) {
      if (error instanceof AppError) throw error
      throw mapCloudflareError(error)
    }
  })

  app.delete('/:orgId/custom-hostnames/:customHostnameId', async (c) => {
    const orgId = c.req.param('orgId')
    const auth = await requireApiKeyOrOrgManager(c, orgId, 'custom_hostnames:write')
    const db = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
    const row = await db.customHostnames.findOne(
      and(
        eq(schema.customHostnames.id, c.req.param('customHostnameId')),
        ne(schema.customHostnames.status, 'deleted'),
      ),
    )
    if (!row || !row.cloudflareHostnameId) throw new AppError('not_found', { httpStatus: 404 })

    try {
      await clientFactory(c.env).delete(row.cloudflareHostnameId)
    } catch (error) {
      await db.customHostnames.update(
        { status: 'deletion_failed' },
        eq(schema.customHostnames.id, row.id),
      )
      throw mapCloudflareError(error)
    }

    const deleted = await persistCustomHostnameStateWithAudit(c.env, {
      row,
      patch: {
        status: 'deleted',
        hostnameStatus: 'deleted',
        sslStatus: null,
        ownershipExpiresAt: null,
        deletedAt: new Date(),
      },
      action: 'custom_hostname.deleted',
      actorId: auditActorId(auth),
    })
    return c.json({
      id: deleted.id,
      status: 'deleted',
      remove_dns_record: {
        type: 'CNAME',
        name: deleted.hostname,
        value: deleted.trafficCnameTarget,
      },
    })
  })

  return app
}

export function registerCustomHostnameRoutes(
  parent: Hono<XidHonoEnv>,
  options: RegisterCustomHostnamesOptions = {},
): void {
  parent.route('/v1/organizations', appFor(options))
}
