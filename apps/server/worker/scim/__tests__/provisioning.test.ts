// 入站 SCIM 与 XID User 绑定的端到端测试(真实 SQLite + 全量 migration):
// 建号与 managed membership、邮箱关联规则、active=false 停用与 refresh family 撤销、DELETE、跨租户。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import type { XidHonoEnv } from '../../lib/types'
import { makeEnv, makeFakeDoNs, makeFakeKv } from '../../oidc/__tests__/helpers'
import { registerScimRoutes } from '../index'

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))
const TOKEN = 'scim_provisioning_token'
const OTHER_TOKEN = 'scim_other_tenant_token'

function tenantContext(tenantId: string): TenantContext {
  return {
    tenantId,
    issuer: 'https://xid.dev',
    rpId: `${tenantId}.xid.dev`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

async function setup() {
  const d1 = new SqliteD1()
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    d1.database.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
  const db = d1 as unknown as D1Database
  const tenant = tenantContext('t_1')
  const other = tenantContext('t_2')
  const tenantDb = createTenantDb(db, tenant)
  await tenantDb.directories.insert({
    id: 'dir_1',
    tenantId: 't_1',
    orgId: 'org_sub',
    provider: 'okta',
    scimTokenHash: await sha256Hex(TOKEN),
  })
  await createTenantDb(db, other).directories.insert({
    id: 'dir_2',
    tenantId: 't_2',
    orgId: 't_2',
    provider: 'okta',
    scimTokenHash: await sha256Hex(OTHER_TOKEN),
  })
  const revokeCalls: string[] = []
  const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
  const env = {
    ...makeEnv({
      DB: db,
      CACHE: makeFakeKv(),
      SESSION_REVOCATION: makeFakeDoNs((path) => {
        revokeCalls.push(path)
        return new Response('{}', { status: 200 })
      }),
    }),
    WEBHOOK_QUEUE: webhookQueue,
  } as unknown as Env
  return { db, tenantDb, tenant, other, env, revokeCalls, webhookQueue }
}

function scimApp(tenant: TenantContext): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c, next) => {
    c.set('tenant', tenant)
    c.set('session', null)
    await next()
  })
  registerScimRoutes(app)
  return app
}

type ScimRequest = {
  method: string
  path: string
  body?: unknown
  token?: string
  tenantId?: string
}

async function scim(app: Hono<XidHonoEnv>, env: Env, request: ScimRequest): Promise<Response> {
  const tenantId = request.tenantId ?? 't_1'
  return app.request(
    `https://xid.dev/scim/v2/organizations/${tenantId}${request.path}`,
    {
      method: request.method,
      headers: {
        Authorization: `Bearer ${request.token ?? TOKEN}`,
        'Content-Type': 'application/scim+json',
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    },
    env,
  )
}

function scimUser(email: string, active = true) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: email,
    name: { givenName: 'Alice', familyName: 'Doe' },
    emails: [{ value: email, primary: true }],
    active,
  }
}

const deactivatePatch = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', path: 'active', value: false }],
}

async function seedUser(
  tenantDb: ReturnType<typeof createTenantDb>,
  input: { id: string; email: string; memberOf?: string },
): Promise<void> {
  await tenantDb.users.insert({ id: input.id, tenantId: tenantDb.tenantId, status: 'active' })
  await tenantDb.userEmails.insert({
    id: `${input.id}_email`,
    tenantId: tenantDb.tenantId,
    userId: input.id,
    email: input.email,
    verified: true,
    verificationStatus: 'verified',
    isPrimary: true,
  })
  if (input.memberOf) {
    await tenantDb.memberships.insert({
      id: `${input.id}_membership`,
      tenantId: tenantDb.tenantId,
      orgId: input.memberOf,
      userId: input.id,
      role: 'admin',
      status: 'active',
    })
  }
}

async function createdUserId(response: Response, tenantDb: ReturnType<typeof createTenantDb>) {
  const body = (await response.json()) as { id: string }
  const row = await tenantDb.directoryUsers.findOne(eq(schema.directoryUsers.id, body.id))
  return { directoryUserId: body.id, userId: row?.userId ?? null }
}

describe('inbound SCIM provisioning into XID users', () => {
  it('creates an XID user, primary email and managed membership in the directory org', async () => {
    const { tenantDb, tenant, env, webhookQueue } = await setup()
    const app = scimApp(tenant)

    const res = await scim(app, env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('Alice@Example.com'),
    })

    expect(res.status).toBe(201)
    const { userId } = await createdUserId(res, tenantDb)
    expect(userId).toBeTruthy()
    const user = await tenantDb.users.findOne(eq(schema.users.id, userId!))
    expect(user).toMatchObject({ status: 'active', provisionedBy: 'scim', firstName: 'Alice' })
    const email = await tenantDb.userEmails.findOne(eq(schema.userEmails.userId, userId!))
    expect(email).toMatchObject({ email: 'alice@example.com', verified: true, isPrimary: true })
    const membership = await tenantDb
      .forOrg('org_sub')
      .memberships.findOne(eq(schema.memberships.userId, userId!))
    expect(membership).toMatchObject({ role: 'member', status: 'active', isManaged: true })
    expect(webhookQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.created' }),
    )
  })

  it('links an existing verified user who is already a member of the directory org', async () => {
    const { tenantDb, tenant, env } = await setup()
    await seedUser(tenantDb, { id: 'user_member', email: 'bob@example.com', memberOf: 'org_sub' })

    const res = await scim(scimApp(tenant), env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('bob@example.com'),
    })

    expect(res.status).toBe(201)
    expect((await createdUserId(res, tenantDb)).userId).toBe('user_member')
    const membership = await tenantDb
      .forOrg('org_sub')
      .memberships.findOne(eq(schema.memberships.userId, 'user_member'))
    expect(membership?.role).toBe('admin')
  })

  it('rejects an email owned by a user outside the directory org without a verified domain', async () => {
    const { tenantDb, tenant, env } = await setup()
    await seedUser(tenantDb, { id: 'user_other_org', email: 'eve@example.com', memberOf: 't_1' })

    const res = await scim(scimApp(tenant), env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('eve@example.com'),
    })

    expect(res.status).toBe(409)
    expect(((await res.json()) as Record<string, unknown>)['scimType']).toBe('uniqueness')
    expect(await tenantDb.directoryUsers.count()).toBe(0)
    const membership = await tenantDb
      .forOrg('org_sub')
      .memberships.findOne(eq(schema.memberships.userId, 'user_other_org'))
    expect(membership).toBeUndefined()
  })

  it('links a non-member when the email domain is verified for the directory org', async () => {
    const { tenantDb, tenant, env } = await setup()
    await seedUser(tenantDb, { id: 'user_domain', email: 'dan@corp.example', memberOf: 't_1' })
    await tenantDb.organizationDomains.insert({
      id: 'dom_1',
      tenantId: 't_1',
      orgId: 'org_sub',
      domain: 'corp.example',
      verificationToken: 'token',
      verificationStatus: 'verified',
    })

    const res = await scim(scimApp(tenant), env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('dan@corp.example'),
    })

    expect(res.status).toBe(201)
    expect((await createdUserId(res, tenantDb)).userId).toBe('user_domain')
  })

  it('PATCH active=false without If-Match deactivates the user and revokes refresh families', async () => {
    const { tenantDb, tenant, env, revokeCalls } = await setup()
    const app = scimApp(tenant)
    const created = await scim(app, env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('carol@example.com'),
    })
    const { directoryUserId, userId } = await createdUserId(created, tenantDb)
    await tenantDb.refreshTokens.insert({
      id: 'rt_1',
      tenantId: 't_1',
      tokenHash: 'hash_1',
      familyId: 'family_1',
      userId: userId!,
      clientId: 'client_1',
      scope: 'openid offline_access',
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    })

    const res = await scim(app, env, {
      method: 'PATCH',
      path: `/Users/${directoryUserId}`,
      body: deactivatePatch,
    })

    expect(res.status).toBe(200)
    expect((await tenantDb.users.findOne(eq(schema.users.id, userId!)))?.status).toBe('deactivated')
    const token = await tenantDb.refreshTokens.findOne(eq(schema.refreshTokens.id, 'rt_1'))
    expect(token?.familyRevokedAt).toBeInstanceOf(Date)
    expect(revokeCalls.some((path) => path.includes('revoke-all'))).toBe(true)
    const directoryUser = await tenantDb.directoryUsers.findOne(
      eq(schema.directoryUsers.id, directoryUserId),
    )
    expect(directoryUser).toMatchObject({ active: false, status: 'deactivated' })
  })

  it('reactivation restores only a SCIM-deactivated account, never a banned one', async () => {
    const { tenantDb, tenant, env } = await setup()
    const app = scimApp(tenant)
    const created = await scim(app, env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('frank@example.com'),
    })
    const { directoryUserId, userId } = await createdUserId(created, tenantDb)
    await scim(app, env, {
      method: 'PATCH',
      path: `/Users/${directoryUserId}`,
      body: deactivatePatch,
    })
    await tenantDb.users.update({ status: 'banned' }, eq(schema.users.id, userId!))

    const res = await scim(app, env, {
      method: 'PUT',
      path: `/Users/${directoryUserId}`,
      body: scimUser('frank@example.com', true),
    })

    expect(res.status).toBe(200)
    expect((await tenantDb.users.findOne(eq(schema.users.id, userId!)))?.status).toBe('banned')
  })

  it('PUT active=true after deactivation restores the XID user', async () => {
    const { tenantDb, tenant, env } = await setup()
    const app = scimApp(tenant)
    const created = await scim(app, env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('gina@example.com'),
    })
    const { directoryUserId, userId } = await createdUserId(created, tenantDb)
    await scim(app, env, {
      method: 'PATCH',
      path: `/Users/${directoryUserId}`,
      body: deactivatePatch,
    })

    const res = await scim(app, env, {
      method: 'PUT',
      path: `/Users/${directoryUserId}`,
      body: scimUser('gina@example.com', true),
    })

    expect(res.status).toBe(200)
    expect((await tenantDb.users.findOne(eq(schema.users.id, userId!)))?.status).toBe('active')
  })

  it('DELETE deactivates the user and the managed membership but keeps the XID user', async () => {
    const { tenantDb, tenant, env } = await setup()
    const app = scimApp(tenant)
    const created = await scim(app, env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('henry@example.com'),
    })
    const { directoryUserId, userId } = await createdUserId(created, tenantDb)

    const res = await scim(app, env, { method: 'DELETE', path: `/Users/${directoryUserId}` })

    expect(res.status).toBe(204)
    const user = await tenantDb.users.findOne(eq(schema.users.id, userId!))
    expect(user?.status).toBe('deactivated')
    const membership = await tenantDb
      .forOrg('org_sub')
      .memberships.findOne(
        and(eq(schema.memberships.userId, userId!), eq(schema.memberships.isManaged, true)),
      )
    expect(membership?.status).toBe('inactive')
  })

  it('a directory in another tenant never links or touches this tenant user', async () => {
    const { db, tenantDb, other, env } = await setup()
    await seedUser(tenantDb, { id: 'user_t1', email: 'ivy@example.com', memberOf: 'org_sub' })

    const res = await scim(scimApp(other), env, {
      method: 'POST',
      path: '/Users',
      body: scimUser('ivy@example.com'),
      token: OTHER_TOKEN,
      tenantId: 't_2',
    })

    expect(res.status).toBe(201)
    const otherDb = createTenantDb(db, other)
    const { userId } = await createdUserId(res, otherDb)
    expect(userId).not.toBe('user_t1')
    expect((await otherDb.users.findOne(eq(schema.users.id, userId!)))?.tenantId).toBe('t_2')
    expect((await tenantDb.users.findOne(eq(schema.users.id, 'user_t1')))?.status).toBe('active')
  })
})
