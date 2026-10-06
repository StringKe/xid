// Console 视角的入站 SCIM 目录:/v1/organizations/:id/directories。
// 领域操作在 scim/directory-admin.ts;写操作受 allow_org_self_service 门控(02 章 6)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import { readAllById } from '../lib/db-pagination'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  createDirectory,
  deleteDirectory,
  rotateDirectoryToken,
  scimBaseUrl,
} from '../scim/directory-admin'
import { assertOrgSelfServiceEditable } from './org-self-service'
import { auditOrgMutation } from './org-shared'
import { requireApiKeyOrOrgManager, requireOrg, type OrgScopedAuth } from './shared'

const COUNT_BATCH_SIZE = 100

const createDirectoryBodySchema = v.object({
  provider: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
})

type DirectoryRecord = typeof schema.directories.$inferSelect

async function toConsoleDirectories(c: Context<XidHonoEnv>, rows: readonly DirectoryRecord[]) {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const baseUrl = scimBaseUrl(tenant)
  const userCounts = new Map<string, number>()
  const groupCounts = new Map<string, number>()
  for (let start = 0; start < rows.length; start += COUNT_BATCH_SIZE) {
    const directoryIds = rows.slice(start, start + COUNT_BATCH_SIZE).map((row) => row.id)
    const [userRows, groupRows] = await Promise.all([
      db.directoryUsers.countBy(
        schema.directoryUsers.directoryId,
        and(
          inArray(schema.directoryUsers.directoryId, directoryIds),
          ne(schema.directoryUsers.status, 'deleted'),
          isNull(schema.directoryUsers.deletedAt),
        ),
      ),
      db.directoryGroups.countBy(
        schema.directoryGroups.directoryId,
        and(
          inArray(schema.directoryGroups.directoryId, directoryIds),
          ne(schema.directoryGroups.status, 'deleted'),
          isNull(schema.directoryGroups.deletedAt),
        ),
      ),
    ])
    for (const [directoryId, count] of userRows) userCounts.set(directoryId, count)
    for (const [directoryId, count] of groupRows) groupCounts.set(directoryId, count)
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.provider,
    provider: row.provider,
    status: row.status === 'active' ? 'active' : 'inactive',
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    userCount: userCounts.get(row.id) ?? 0,
    groupCount: groupCounts.get(row.id) ?? 0,
    scimBaseUrl: baseUrl,
  }))
}

async function requireEditableDirectoryManager(
  c: Context<XidHonoEnv>,
  orgId: string,
): Promise<OrgScopedAuth> {
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'directories:write')
  await assertOrgSelfServiceEditable(c, auth, await requireOrg(c, orgId))
  return auth
}

function orgDirectoryWhere(orgId: string, directoryId: string) {
  return and(eq(schema.directories.id, directoryId), eq(schema.directories.orgId, orgId))
}

export function registerOrganizationDirectoryRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/:id/directories', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'directories:read')
    const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(id)
    const active = eq(schema.directories.status, 'active')
    const rows = await readAllById((cursor, limit) =>
      orgDb.directories.findMany(cursor ? and(active, gt(schema.directories.id, cursor)) : active, {
        orderBy: asc(schema.directories.id),
        limit,
      }),
    )
    return c.json(await toConsoleDirectories(c, rows))
  })

  app.post('/:id/directories', async (c) => {
    const id = c.req.param('id')
    const auth = await requireEditableDirectoryManager(c, id)
    const tenant = c.get('tenant')
    const json = await readJsonBody(c)
    if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
    const body = validateBody(createDirectoryBodySchema, json.value)
    const { row, token } = await createDirectory(createTenantDb(c.env.DB, tenant), {
      tenantId: tenant.tenantId,
      orgId: id,
      provider: body.provider ?? 'generic',
    })
    auditOrgMutation(c, auth, {
      action: 'directory.created',
      orgId: id,
      targetType: 'directory',
      targetId: row.id,
      details: { provider: row.provider },
    })
    const [directory] = await toConsoleDirectories(c, [row])
    return c.json({ ...directory, scimToken: token }, 201)
  })

  app.post('/:id/directories/:directoryId/rotate-token', async (c) => {
    const id = c.req.param('id')
    const auth = await requireEditableDirectoryManager(c, id)
    const tenant = c.get('tenant')
    const directoryId = c.req.param('directoryId')
    const rotated = await rotateDirectoryToken(
      createTenantDb(c.env.DB, tenant),
      orgDirectoryWhere(id, directoryId),
    )
    if (!rotated) throw new AppError('not_found', { httpStatus: 404 })
    auditOrgMutation(c, auth, {
      action: 'directory.scim_token_rotated',
      orgId: id,
      targetType: 'directory',
      targetId: directoryId,
    })
    return c.json({
      scimToken: rotated.token,
      scimBaseUrl: scimBaseUrl(tenant),
      scimTokenPrevExpiresAt: rotated.previousTokenExpiresAt.toISOString(),
    })
  })

  app.delete('/:id/directories/:directoryId', async (c) => {
    const id = c.req.param('id')
    const auth = await requireEditableDirectoryManager(c, id)
    const directoryId = c.req.param('directoryId')
    const deleted = await deleteDirectory(
      createTenantDb(c.env.DB, c.get('tenant')),
      orgDirectoryWhere(id, directoryId),
    )
    if (!deleted) throw new AppError('not_found', { httpStatus: 404 })
    auditOrgMutation(c, auth, {
      action: 'directory.deleted',
      orgId: id,
      targetType: 'directory',
      targetId: directoryId,
    })
    return new Response(null, { status: 204 })
  })
}
