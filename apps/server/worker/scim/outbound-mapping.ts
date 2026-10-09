// 出站 SCIM 本地资源到下游 id 的稳定映射(scim_target_resources)。

import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, asc, eq, gt } from 'drizzle-orm'
import { readAllById } from '../lib/db-pagination'

export type ScimTarget = typeof schema.scimTargets.$inferSelect
export type ScimTargetResource = typeof schema.scimTargetResources.$inferSelect
export type ScimResourceType = 'User' | 'Group'
type TenantDb = ReturnType<typeof createTenantDb>

export type SyncRuntime = {
  env: Env
  tenant: TenantContext
  target: ScimTarget
  db: TenantDb
  token: string
}

function mappingWhere(targetId: string, resourceType: ScimResourceType, localResourceId: string) {
  return and(
    eq(schema.scimTargetResources.targetId, targetId),
    eq(schema.scimTargetResources.resourceType, resourceType),
    eq(schema.scimTargetResources.localResourceId, localResourceId),
  )
}

export async function findMapping(
  db: TenantDb,
  target: ScimTarget,
  resourceType: ScimResourceType,
  localResourceId: string,
): Promise<ScimTargetResource | undefined> {
  return db
    .forOrg(target.orgId)
    .scimTargetResources.findOne(mappingWhere(target.id, resourceType, localResourceId))
}

export async function targetMappings(
  db: TenantDb,
  target: ScimTarget,
): Promise<ScimTargetResource[]> {
  const store = db.forOrg(target.orgId).scimTargetResources
  const byTarget = eq(schema.scimTargetResources.targetId, target.id)
  return readAllById((cursor, limit) =>
    store.findMany(cursor ? and(byTarget, gt(schema.scimTargetResources.id, cursor)) : byTarget, {
      orderBy: asc(schema.scimTargetResources.id),
      limit,
    }),
  )
}

export async function persistMapping(input: {
  db: TenantDb
  target: ScimTarget
  resourceType: ScimResourceType
  localResourceId: string
  externalId: string
  downstreamId: string
  status: 'active' | 'deprovisioned'
  existing?: ScimTargetResource
}): Promise<void> {
  const { db, target, resourceType, localResourceId, externalId, downstreamId, status } = input
  const store = db.forOrg(target.orgId).scimTargetResources
  const now = new Date()
  const current = input.existing ?? (await findMapping(db, target, resourceType, localResourceId))
  if (current) {
    await store.update(
      { downstreamId, externalId, status, lastSyncedAt: now },
      eq(schema.scimTargetResources.id, current.id),
    )
    return
  }
  try {
    await store.insert({
      id: crypto.randomUUID(),
      tenantId: target.tenantId,
      orgId: target.orgId,
      targetId: target.id,
      resourceType,
      localResourceId,
      externalId,
      downstreamId,
      status,
      lastSyncedAt: now,
    })
  } catch (error) {
    const raced = await findMapping(db, target, resourceType, localResourceId)
    if (!raced) throw error
    await store.update(
      { downstreamId, externalId, status, lastSyncedAt: now },
      eq(schema.scimTargetResources.id, raced.id),
    )
  }
}
