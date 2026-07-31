// Outbound SCIM client:XID 向下游 SaaS SCIM target 推送 users/groups。
// 与 inbound `/scim/v2/organizations/:organization_id/*` 分离,避免方向混淆。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type {
  OrganizationMembershipRole,
  ScimSyncQueueMessage,
  TenantContext,
} from '@xid-kit/types'
import { trimLeadingSlashes, trimTrailingSlashes } from '../../shared/url'
import { AppError } from '../lib/errors'
import { readAllById } from '../lib/db-pagination'
import { filterMembershipsByAssignmentGate, parseAssignmentGate } from '../sso/assignment-gate'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { requireOrgManager } from '../v1/shared'
import { normalizeScimTargetBaseUrl, requireScimTargetToken } from './target-credentials'

type ScimTarget = typeof schema.scimTargets.$inferSelect
type UserRow = typeof schema.users.$inferSelect
type UserEmailRow = typeof schema.userEmails.$inferSelect
type MembershipRow = typeof schema.memberships.$inferSelect
type ScimTargetResource = typeof schema.scimTargetResources.$inferSelect

const USER_BATCH_SIZE = 100
// D1 allows 100 bound parameters per query; tenant_id and deleted status consume two.
const USER_ID_QUERY_BATCH_SIZE = 98

const outbound = new Hono<XidHonoEnv>()
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'

type SyncSummary = {
  targetId: string
  provider: string
  users: number
  groups: number
  deactivations: number
}

type ScimResourceType = 'User' | 'Group'

type ExecuteScimTargetSyncInput = {
  env: Env
  tenant: TenantContext
  target: ScimTarget
}

type SyncRuntime = ExecuteScimTargetSyncInput & {
  db: ReturnType<typeof createTenantDb>
  token: string
}

export class OutboundScimRequestError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(
      statusCode === undefined
        ? 'outbound_scim_network_failure'
        : `outbound_scim_http_${statusCode}`,
    )
    this.name = 'OutboundScimRequestError'
  }
}

function requireSession(c: Context<XidHonoEnv>): SessionData {
  const session = c.get('session')
  if (!session || session.status !== 'active') {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  return session
}

function requiredParam(c: Context<XidHonoEnv>, name: string): string {
  const value = c.req.param(name)
  if (!value) throw new AppError('invalid_request', { httpStatus: 400 })
  return value
}

async function resolveTarget(c: Context<XidHonoEnv>, targetId: string): Promise<ScimTarget> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const target = await db.scimTargets.findOne(
    and(eq(schema.scimTargets.id, targetId), eq(schema.scimTargets.status, 'active')),
  )
  if (!target) throw new AppError('not_found', { httpStatus: 404 })
  return target
}

function endpoint(target: ScimTarget, path: string, environment: string | undefined): string {
  const baseUrl = normalizeScimTargetBaseUrl(target.baseUrl, { environment })
  return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`
}

async function scimFetch({
  environment,
  target,
  token,
  path,
  init,
  acceptedStatuses = [],
}: {
  environment: string | undefined
  target: ScimTarget
  token: string
  path: string
  init: RequestInit
  acceptedStatuses?: readonly number[]
}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Content-Type', 'application/scim+json')
  let res: Response
  try {
    res = await fetch(endpoint(target, path, environment), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    })
  } catch {
    throw new OutboundScimRequestError(undefined, true, undefined)
  }
  if ((res.status < 200 || res.status >= 300) && !acceptedStatuses.includes(res.status)) {
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500
    throw new OutboundScimRequestError(
      res.status,
      retryable,
      res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined,
    )
  }
  return res
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const delta = Number(value)
  if (Number.isInteger(delta) && delta >= 0) return Math.min(86_400, Math.max(1, delta))
  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return undefined
  const seconds = Math.ceil((retryAt - Date.now()) / 1000)
  return Math.min(86_400, Math.max(1, seconds))
}

async function primaryEmails(
  env: Env,
  tenant: TenantContext,
  users: readonly UserRow[],
): Promise<Map<string, UserEmailRow>> {
  if (users.length === 0) return new Map()
  const db = createTenantDb(env.DB, tenant)
  const filter = inArray(
    schema.userEmails.userId,
    users.map((user) => user.id),
  )
  const rows = await readAllById((cursor, limit) =>
    db.userEmails.findMany(cursor ? and(filter, gt(schema.userEmails.id, cursor)) : filter, {
      orderBy: asc(schema.userEmails.id),
      limit,
    }),
  )
  const byUser = new Map<string, UserEmailRow[]>()
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row])
  const out = new Map<string, UserEmailRow>()
  for (const user of users) {
    const candidates = byUser.get(user.id) ?? []
    const email =
      candidates.find((candidate) => candidate.id === user.primaryEmailId) ??
      candidates.find((candidate) => candidate.isPrimary) ??
      candidates[0]
    if (email) out.set(user.id, email)
  }
  return out
}

function scimUser(user: UserRow, email: UserEmailRow | undefined): Record<string, unknown> {
  const emailValue = email?.email ?? user.username ?? user.id
  return {
    schemas: [USER_SCHEMA],
    externalId: user.id,
    userName: emailValue,
    active: user.status === 'active' && !user.deletedAt,
    name: {
      givenName: user.firstName ?? '',
      familyName: user.lastName ?? '',
      formatted: user.displayName ?? '',
    },
    emails: [{ value: emailValue, primary: true }],
  }
}

async function membershipsForOrg(
  env: Env,
  tenant: TenantContext,
  orgId: string,
): Promise<MembershipRow[]> {
  const db = createTenantDb(env.DB, tenant)
  const rows: MembershipRow[] = []
  let cursor: string | null = null
  while (true) {
    const after = cursor ? gt(schema.memberships.id, cursor) : undefined
    const page = await db.memberships.findMany(
      after
        ? and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active'), after)
        : and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
      { orderBy: asc(schema.memberships.id), limit: USER_BATCH_SIZE },
    )
    if (page.length === 0) break
    rows.push(...page)
    cursor = page[page.length - 1]?.id ?? null
    if (page.length < USER_BATCH_SIZE) break
  }
  return rows
}

function groupedMemberships(
  memberships: readonly MembershipRow[],
): Map<OrganizationMembershipRole, MembershipRow[]> {
  const out = new Map<OrganizationMembershipRole, MembershipRow[]>()
  for (const membership of memberships) {
    const key: OrganizationMembershipRole = membership.role || 'member'
    const existing = out.get(key) ?? []
    existing.push(membership)
    out.set(key, existing)
  }
  return out
}

function scimGroup(
  role: OrganizationMembershipRole,
  memberships: readonly MembershipRow[],
  downstreamUserIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    externalId: `role:${role}`,
    displayName: role,
    members: memberships.flatMap((membership) => {
      const downstreamId = downstreamUserIds.get(membership.userId)
      return downstreamId ? [{ value: downstreamId, display: membership.userId }] : []
    }),
  }
}

function emptyScimGroupForResource(localResourceId: string): Record<string, unknown> {
  const name = localResourceId.startsWith('role:')
    ? localResourceId.slice('role:'.length)
    : localResourceId
  return {
    schemas: [GROUP_SCHEMA],
    externalId: `role:${name}`,
    displayName: name,
    members: [],
  }
}

function resourcePath(type: ScimResourceType): 'Users' | 'Groups' {
  return type === 'User' ? 'Users' : 'Groups'
}

function mappingWhere(targetId: string, resourceType: ScimResourceType, localResourceId: string) {
  return and(
    eq(schema.scimTargetResources.targetId, targetId),
    eq(schema.scimTargetResources.resourceType, resourceType),
    eq(schema.scimTargetResources.localResourceId, localResourceId),
  )
}

async function findMapping(
  db: ReturnType<typeof createTenantDb>,
  target: ScimTarget,
  resourceType: ScimResourceType,
  localResourceId: string,
): Promise<ScimTargetResource | undefined> {
  return db
    .forOrg(target.orgId)
    .scimTargetResources.findOne(mappingWhere(target.id, resourceType, localResourceId))
}

async function targetMappings(
  db: ReturnType<typeof createTenantDb>,
  target: ScimTarget,
): Promise<ScimTargetResource[]> {
  const store = db.forOrg(target.orgId).scimTargetResources
  return readAllById((cursor, limit) =>
    store.findMany(
      cursor
        ? and(
            eq(schema.scimTargetResources.targetId, target.id),
            gt(schema.scimTargetResources.id, cursor),
          )
        : eq(schema.scimTargetResources.targetId, target.id),
      { orderBy: asc(schema.scimTargetResources.id), limit },
    ),
  )
}

async function persistMapping({
  db,
  target,
  resourceType,
  localResourceId,
  externalId,
  downstreamId,
  status,
  existing,
}: {
  db: ReturnType<typeof createTenantDb>
  target: ScimTarget
  resourceType: ScimResourceType
  localResourceId: string
  externalId: string
  downstreamId: string
  status: 'active' | 'deprovisioned'
  existing?: ScimTargetResource
}): Promise<void> {
  const store = db.forOrg(target.orgId).scimTargetResources
  const now = new Date()
  const current = existing ?? (await findMapping(db, target, resourceType, localResourceId))
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

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // The downstream body is intentionally not included in logs or client errors.
  }
  throw new OutboundScimRequestError(502, true, undefined)
}

function escapeScimFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function discoverDownstreamId({
  environment,
  target,
  token,
  resourceType,
  externalId,
}: {
  environment: string | undefined
  target: ScimTarget
  token: string
  resourceType: ScimResourceType
  externalId: string
}): Promise<string | undefined> {
  const filter = `externalId eq "${escapeScimFilterValue(externalId)}"`
  const response = await scimFetch({
    environment,
    target,
    token,
    path: `/${resourcePath(resourceType)}?filter=${encodeURIComponent(filter)}`,
    init: { method: 'GET' },
  })
  const body = await responseObject(response)
  const resources = body['Resources']
  if (!Array.isArray(resources)) throw new OutboundScimRequestError(502, true, undefined)
  if (Array.isArray(body['schemas']) && !body['schemas'].includes(LIST_RESPONSE_SCHEMA)) {
    throw new OutboundScimRequestError(502, true, undefined)
  }
  const ids = resources.flatMap((resource) => {
    if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) return []
    const id = (resource as Record<string, unknown>)['id']
    return typeof id === 'string' && id.length > 0 ? [id] : []
  })
  if (ids.length > 1) throw new OutboundScimRequestError(409, false, undefined)
  return ids[0]
}

async function createDownstreamResource({
  environment,
  target,
  token,
  resourceType,
  externalId,
  body,
}: {
  environment: string | undefined
  target: ScimTarget
  token: string
  resourceType: ScimResourceType
  externalId: string
  body: Record<string, unknown>
}): Promise<string> {
  const response = await scimFetch({
    environment,
    target,
    token,
    path: `/${resourcePath(resourceType)}`,
    init: { method: 'POST', body: JSON.stringify(body) },
    acceptedStatuses: [409],
  })
  if (response.status === 409) {
    const discovered = await discoverDownstreamId({
      environment,
      target,
      token,
      resourceType,
      externalId,
    })
    if (!discovered) throw new OutboundScimRequestError(409, false, undefined)
    const replaced = await replaceDownstreamResource({
      environment,
      target,
      token,
      resourceType,
      downstreamId: discovered,
      body,
    })
    if (!replaced) throw new OutboundScimRequestError(502, true, undefined)
    return discovered
  }
  const created = await responseObject(response)
  if (typeof created['id'] === 'string' && created['id'].length > 0) return created['id']
  const discovered = await discoverDownstreamId({
    environment,
    target,
    token,
    resourceType,
    externalId,
  })
  if (discovered) return discovered
  throw new OutboundScimRequestError(502, true, undefined)
}

async function replaceDownstreamResource({
  environment,
  target,
  token,
  resourceType,
  downstreamId,
  body,
}: {
  environment: string | undefined
  target: ScimTarget
  token: string
  resourceType: ScimResourceType
  downstreamId: string
  body: Record<string, unknown>
}): Promise<boolean> {
  const response = await scimFetch({
    environment,
    target,
    token,
    path: `/${resourcePath(resourceType)}/${encodeURIComponent(downstreamId)}`,
    init: { method: 'PUT', body: JSON.stringify(body) },
    acceptedStatuses: [404],
  })
  return response.status !== 404
}

async function upsertResource(
  runtime: Pick<SyncRuntime, 'env' | 'db' | 'target' | 'token'>,
  input: {
    resourceType: ScimResourceType
    localResourceId: string
    externalId: string
    body: Record<string, unknown>
    status: 'active' | 'deprovisioned'
  },
): Promise<string> {
  const { env, db, target, token } = runtime
  const environment = env.ENVIRONMENT
  const existing = await findMapping(db, target, input.resourceType, input.localResourceId)
  let downstreamId = existing?.downstreamId
  if (
    downstreamId &&
    (await replaceDownstreamResource({
      environment,
      target,
      token,
      resourceType: input.resourceType,
      downstreamId,
      body: input.body,
    }))
  ) {
    await persistMapping({
      db,
      target,
      resourceType: input.resourceType,
      localResourceId: input.localResourceId,
      externalId: input.externalId,
      downstreamId,
      status: input.status,
      existing,
    })
    return downstreamId
  }

  downstreamId = await discoverDownstreamId({
    environment,
    target,
    token,
    resourceType: input.resourceType,
    externalId: input.externalId,
  })
  if (downstreamId) {
    const replaced = await replaceDownstreamResource({
      environment,
      target,
      token,
      resourceType: input.resourceType,
      downstreamId,
      body: input.body,
    })
    if (!replaced) throw new OutboundScimRequestError(502, true, undefined)
  } else {
    downstreamId = await createDownstreamResource({
      environment,
      target,
      token,
      resourceType: input.resourceType,
      externalId: input.externalId,
      body: input.body,
    })
  }
  await persistMapping({
    db,
    target,
    resourceType: input.resourceType,
    localResourceId: input.localResourceId,
    externalId: input.externalId,
    downstreamId,
    status: input.status,
    existing,
  })
  return downstreamId
}

async function syncUsers({
  env,
  tenant,
  db,
  target,
  token,
  users,
  downstreamUserIds,
}: SyncRuntime & {
  users: readonly UserRow[]
  downstreamUserIds: Map<string, string>
}): Promise<{ users: number; deactivations: number }> {
  const emails = await primaryEmails(env, tenant, users)
  let deactivations = 0
  for (const user of users) {
    const body = scimUser(user, emails.get(user.id))
    const active = body['active'] === true
    const downstreamId = await upsertResource(
      { env, db, target, token },
      {
        resourceType: 'User',
        localResourceId: user.id,
        externalId: user.id,
        body,
        status: active ? 'active' : 'deprovisioned',
      },
    )
    downstreamUserIds.set(user.id, downstreamId)
    if (!active) deactivations += 1
  }
  return { users: users.length, deactivations }
}

async function syncGroupsWithMemberships({
  env,
  db,
  target,
  token,
  memberships,
  downstreamUserIds,
}: SyncRuntime & {
  memberships: readonly MembershipRow[]
  downstreamUserIds: ReadonlyMap<string, string>
}): Promise<Set<string>> {
  const groups = groupedMemberships(memberships)
  const localGroupIds = new Set<string>()
  for (const [role, groupMemberships] of groups.entries()) {
    const localResourceId = `role:${role}`
    localGroupIds.add(localResourceId)
    await upsertResource(
      { env, db, target, token },
      {
        resourceType: 'Group',
        localResourceId,
        externalId: localResourceId,
        body: scimGroup(role, groupMemberships, downstreamUserIds),
        status: 'active',
      },
    )
  }
  return localGroupIds
}

async function deprovisionStaleMappings({
  env,
  db,
  target,
  token,
  mappings,
  currentUserIds,
  currentGroupIds,
}: SyncRuntime & {
  mappings: readonly ScimTargetResource[]
  currentUserIds: ReadonlySet<string>
  currentGroupIds: ReadonlySet<string>
}): Promise<number> {
  let deactivations = 0
  for (const mapping of mappings) {
    if (mapping.status !== 'active') continue
    if (mapping.resourceType === 'User') {
      if (currentUserIds.has(mapping.localResourceId)) continue
      await scimFetch({
        environment: env.ENVIRONMENT,
        target,
        token,
        path: `/Users/${encodeURIComponent(mapping.downstreamId)}`,
        init: {
          method: 'PATCH',
          body: JSON.stringify({
            schemas: [PATCH_SCHEMA],
            Operations: [{ op: 'replace', path: 'active', value: false }],
          }),
        },
        // A stale mapping may point at a resource already removed by a SaaS admin. That is the
        // desired deprovisioned state, so persist it locally instead of poisoning every retry.
        acceptedStatuses: [404],
      })
      deactivations += 1
    } else {
      if (currentGroupIds.has(mapping.localResourceId)) continue
      await scimFetch({
        environment: env.ENVIRONMENT,
        target,
        token,
        path: `/Groups/${encodeURIComponent(mapping.downstreamId)}`,
        init: {
          method: 'PUT',
          // Cleanup also handles legacy mappings whose display name predates the fixed role enum.
          body: JSON.stringify(emptyScimGroupForResource(mapping.localResourceId)),
        },
        acceptedStatuses: [404],
      })
    }
    await persistMapping({
      db,
      target,
      resourceType: mapping.resourceType,
      localResourceId: mapping.localResourceId,
      externalId: mapping.externalId,
      downstreamId: mapping.downstreamId,
      status: 'deprovisioned',
      existing: mapping,
    })
  }
  return deactivations
}

export async function executeScimTargetSync({
  env,
  tenant,
  target,
}: ExecuteScimTargetSyncInput): Promise<SyncSummary> {
  const db = createTenantDb(env.DB, tenant)
  const gate = parseAssignmentGate(target.userFilter as Record<string, unknown>)
  const token = requireScimTargetToken(env, target.id)
  const memberships = await membershipsForOrg(env, tenant, target.orgId)
  const filteredMemberships = await filterMembershipsByAssignmentGate(db, {
    orgId: target.orgId,
    memberships,
    gate,
  })
  const allowedUserIds = [...new Set(filteredMemberships.map((membership) => membership.userId))]
  const mappings = await targetMappings(db, target)
  const runtime: SyncRuntime = { env, tenant, db, target, token }
  const baseFilter = and(ne(schema.users.status, 'deleted'), isNull(schema.users.deletedAt))
  let syncedUsers = 0
  let deactivations = 0
  const downstreamUserIds = new Map<string, string>()
  for (let start = 0; start < allowedUserIds.length; start += USER_ID_QUERY_BATCH_SIZE) {
    const users = await db.users.findMany(
      and(
        baseFilter,
        inArray(schema.users.id, allowedUserIds.slice(start, start + USER_ID_QUERY_BATCH_SIZE)),
      ),
      {
        orderBy: asc(schema.users.id),
      },
    )
    const result = await syncUsers({ ...runtime, users, downstreamUserIds })
    syncedUsers += result.users
    deactivations += result.deactivations
  }
  const currentGroupIds = await syncGroupsWithMemberships({
    ...runtime,
    memberships: filteredMemberships,
    downstreamUserIds,
  })
  deactivations += await deprovisionStaleMappings({
    ...runtime,
    mappings,
    currentUserIds: new Set(downstreamUserIds.keys()),
    currentGroupIds,
  })
  await db.scimTargets.update({ lastSyncAt: new Date() }, eq(schema.scimTargets.id, target.id))
  return {
    targetId: target.id,
    provider: target.provider,
    users: syncedUsers,
    groups: currentGroupIds.size,
    deactivations,
  }
}

export async function enqueueScimTargetSync(
  c: Context<XidHonoEnv>,
  target: ScimTarget,
  actorId?: string,
): Promise<{ runId: string; targetId: string; status: 'queued' }> {
  requireScimTargetToken(c.env, target.id)
  const tenant = c.get('tenant')
  const runId = crypto.randomUUID()
  const requestedAt = Date.now()
  const message: ScimSyncQueueMessage = {
    tenantId: tenant.tenantId,
    orgId: target.orgId,
    targetId: target.id,
    issuer: tenant.issuer,
    actorId,
    runId,
    requestedAt,
  }
  await c.env.SCIM_QUEUE.send(message)
  return { runId, targetId: target.id, status: 'queued' }
}

outbound.post('/:targetId/sync', async (c) => {
  // 触发入队必须是 org admin/owner 或 org_manager,普通 member 只读不放行。
  const session = requireSession(c)
  const target = await resolveTarget(c, requiredParam(c, 'targetId'))
  await requireOrgManager(c, target.orgId)
  return c.json(await enqueueScimTargetSync(c, target, session.userId), 202)
})

export function registerOutboundScimRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/scim/outbound', outbound)
}
