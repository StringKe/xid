// 入站 SCIM 与 Entra / Okta 实际请求体的兼容性(真实 SQLite + 全量 migration):
// attrPath 与 valuePath PATCH、Okta 改组名、成员移除、唯一性、Location/ETag、Bulk 引用。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import type { XidHonoEnv } from '../../lib/types'
import { makeEnv, makeFakeDoNs, makeFakeKv } from '../../oidc/__tests__/helpers'
import { registerScimRoutes } from '../index'

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))
const TOKEN = 'scim_compat_token'
const OTHER_TOKEN = 'scim_compat_other_token'
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'

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
    orgId: 'org_1',
    provider: 'entra',
    scimTokenHash: await sha256Hex(TOKEN),
  })
  await createTenantDb(db, other).directories.insert({
    id: 'dir_2',
    tenantId: 't_2',
    orgId: 'org_2',
    provider: 'okta',
    scimTokenHash: await sha256Hex(OTHER_TOKEN),
  })
  const revokeCalls: string[] = []
  const env = {
    ...makeEnv({
      DB: db,
      CACHE: makeFakeKv(),
      SESSION_REVOCATION: makeFakeDoNs((path) => {
        revokeCalls.push(path)
        return new Response('{}', { status: 200 })
      }),
    }),
    WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env
  const apps = new Map<string, Hono<XidHonoEnv>>()
  for (const ctx of [tenant, other]) {
    const app = new Hono<XidHonoEnv>()
    app.use('*', async (c, next) => {
      c.set('tenant', ctx)
      c.set('session', null)
      await next()
    })
    registerScimRoutes(app)
    apps.set(ctx.tenantId, app)
  }
  async function scim(request: {
    method: string
    path: string
    body?: unknown
    token?: string
    tenantId?: string
  }): Promise<Response> {
    const tenantId = request.tenantId ?? 't_1'
    return apps.get(tenantId)!.request(
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
  return { tenantDb, scim, revokeCalls }
}

type Harness = Awaited<ReturnType<typeof setup>>

function patchBody(...operations: Record<string, unknown>[]) {
  return { schemas: [PATCH_SCHEMA], Operations: operations }
}

async function createUser(
  harness: Harness,
  userName: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await harness.scim({
    method: 'POST',
    path: '/Users',
    body: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName,
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      emails: [{ type: 'work', value: userName, primary: true }],
      active: true,
      ...extra,
    },
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

async function createGroup(harness: Harness, displayName: string, members: string[] = []) {
  const res = await harness.scim({
    method: 'POST',
    path: '/Groups',
    body: { displayName, members: members.map((value) => ({ value })) },
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

async function getJson(harness: Harness, path: string): Promise<Record<string, unknown>> {
  const res = await harness.scim({ method: 'GET', path })
  return (await res.json()) as Record<string, unknown>
}

describe('SCIM User PATCH attribute paths', () => {
  it('applies Entra sub-attribute, valuePath and enterprise URN paths to the nested resource', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'ada@example.com')

    const res = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody(
        { op: 'Replace', path: 'name.familyName', value: 'King' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ada.king@example.com' },
        { op: 'Add', path: `${ENTERPRISE}:department`, value: 'Analytics' },
      ),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['name']).toMatchObject({ givenName: 'Ada', familyName: 'King' })
    expect(body['emails']).toEqual([{ type: 'work', value: 'ada.king@example.com', primary: true }])
    expect(body[ENTERPRISE]).toEqual({ department: 'Analytics' })
  })

  it('expands dotted and URN keys in a path-less value map', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'grace@example.com')

    const res = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({
        op: 'replace',
        value: { 'name.givenName': 'Grace', [`${ENTERPRISE}:department`]: 'Navy' },
      }),
    })

    const body = (await res.json()) as Record<string, unknown>
    expect(body['name']).toMatchObject({ givenName: 'Grace', familyName: 'Lovelace' })
    expect(body[ENTERPRISE]).toEqual({ department: 'Navy' })
  })

  it('deactivates through a value map carrying the string "False" and revokes sessions', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'entra@example.com')

    const res = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({ op: 'Replace', value: { active: 'False' } }),
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>)['active']).toBe(false)
    expect(harness.revokeCalls.some((path) => path.includes('revoke-all'))).toBe(true)
  })

  it('never persists password sent through a core-schema URN path or value map', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'okta@example.com')

    await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody(
        {
          op: 'replace',
          path: 'urn:ietf:params:scim:schemas:core:2.0:User:password',
          value: 'secret-one',
        },
        {
          op: 'replace',
          value: { 'urn:ietf:params:scim:schemas:core:2.0:User': { Password: 'secret-two' } },
        },
      ),
    })

    const row = await harness.tenantDb.directoryUsers.findOne(eq(schema.directoryUsers.id, id))
    expect(JSON.stringify(row?.scimRaw)).not.toMatch(/secret-/)
  })

  it('returns invalidPath for a malformed path and noTarget for an unmatched replace filter', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'path@example.com')

    const malformed = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({ op: 'replace', path: 'emails[type eq "work"', value: 'x' }),
    })
    const unmatched = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({ op: 'replace', path: 'emails[type eq "home"].value', value: 'x' }),
    })

    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ scimType: 'invalidPath' })
    expect(unmatched.status).toBe(400)
    expect(await unmatched.json()).toMatchObject({ scimType: 'noTarget' })
  })

  it('ignores an id equal to the resource and rejects a different id with mutability', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'ids@example.com')

    const same = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({ op: 'replace', value: { id, meta: { version: 'W/"x"' }, title: 'CEO' } }),
    })
    const different = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({ op: 'replace', value: { id: 'someone-else' } }),
    })

    expect(same.status).toBe(200)
    expect(different.status).toBe(400)
    expect(await different.json()).toMatchObject({ scimType: 'mutability' })
  })

  it('PATCH externalId updates the column used by GET and filter', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'ext@example.com', { externalId: 'old-ext' })

    await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({ op: 'replace', path: 'externalId', value: 'new-ext' }),
    })

    const list = await getJson(
      harness,
      `/Users?filter=${encodeURIComponent('externalId eq "new-ext"')}`,
    )
    expect(list['totalResults']).toBe(1)
    expect((await getJson(harness, `/Users/${id}`))['externalId']).toBe('new-ext')
  })
})

describe('SCIM uniqueness', () => {
  it('recreates a user with the userName and externalId of a deleted user', async () => {
    const harness = await setup()
    const id = await createUser(harness, 'rehire@example.com', { externalId: 'emp-1' })
    expect((await harness.scim({ method: 'DELETE', path: `/Users/${id}` })).status).toBe(204)

    const recreatedId = await createUser(harness, 'rehire@example.com', { externalId: 'emp-1' })

    expect(recreatedId).not.toBe(id)
    const [before, after] = await Promise.all(
      [id, recreatedId].map((rowId) =>
        harness.tenantDb.directoryUsers.findOne(eq(schema.directoryUsers.id, rowId)),
      ),
    )
    expect(after?.userId).toBe(before?.userId)
    const account = await harness.tenantDb.users.findOne(eq(schema.users.id, after!.userId!))
    expect(account?.status).toBe('active')
  })

  it('returns 409 uniqueness when PUT or PATCH renames onto another live user', async () => {
    const harness = await setup()
    await createUser(harness, 'taken@example.com', { externalId: 'emp-taken' })
    const id = await createUser(harness, 'mover@example.com')

    const put = await harness.scim({
      method: 'PUT',
      path: `/Users/${id}`,
      body: { userName: 'TAKEN@example.com', active: true },
    })
    const patch = await harness.scim({
      method: 'PATCH',
      path: `/Users/${id}`,
      body: patchBody({ op: 'replace', path: 'externalId', value: 'emp-taken' }),
    })

    expect(put.status).toBe(409)
    expect(await put.json()).toMatchObject({ scimType: 'uniqueness' })
    expect(patch.status).toBe(409)
    expect(await patch.json()).toMatchObject({ scimType: 'uniqueness' })
  })

  it('recreates a deleted group and rejects renaming onto a live group name', async () => {
    const harness = await setup()
    const first = await createGroup(harness, 'Finance')
    await harness.scim({ method: 'DELETE', path: `/Groups/${first}` })
    await createGroup(harness, 'Finance')
    const other = await createGroup(harness, 'Legal')

    const rename = await harness.scim({
      method: 'PATCH',
      path: `/Groups/${other}`,
      body: patchBody({ op: 'replace', path: 'displayName', value: 'finance' }),
    })

    expect(rename.status).toBe(409)
    expect(await rename.json()).toMatchObject({ scimType: 'uniqueness' })
  })
})

describe('SCIM Group PATCH compatibility', () => {
  it('accepts the Okta rename body that repeats the group id', async () => {
    const harness = await setup()
    const id = await createGroup(harness, 'Okta Old Name')

    const res = await harness.scim({
      method: 'PATCH',
      path: `/Groups/${id}`,
      body: patchBody({ op: 'replace', value: { id, displayName: 'Okta New Name' } }),
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>)['displayName']).toBe('Okta New Name')
  })

  it('removes members selected by members[value eq "x"] including or-combinations', async () => {
    const harness = await setup()
    const a = await createUser(harness, 'a@example.com')
    const b = await createUser(harness, 'b@example.com')
    const c = await createUser(harness, 'c@example.com')
    const groupId = await createGroup(harness, 'Engineering', [a, b, c])

    const res = await harness.scim({
      method: 'PATCH',
      path: `/Groups/${groupId}`,
      body: patchBody(
        { op: 'remove', path: `members[value eq "${a}"]` },
        { op: 'remove', path: `members[value eq "${b}" or value eq "missing"]` },
      ),
    })

    expect(res.status).toBe(200)
    const members = ((await res.json()) as { members: { value: string }[] }).members
    expect(members.map((member) => member.value)).toEqual([c])
  })

  it('finds a group whose name contains "and" with the displayName eq lookup IdPs send', async () => {
    const harness = await setup()
    await createGroup(harness, 'Brand and Marketing')

    const list = await getJson(
      harness,
      `/Groups?filter=${encodeURIComponent('displayName eq "Brand and Marketing"')}`,
    )

    expect(list['totalResults']).toBe(1)
  })

  it('returns Location and ETag on 201 for Users and Groups', async () => {
    const harness = await setup()

    const user = await harness.scim({
      method: 'POST',
      path: '/Users',
      body: { userName: 'loc@example.com' },
    })
    const group = await harness.scim({
      method: 'POST',
      path: '/Groups',
      body: { displayName: 'Loc' },
    })

    for (const res of [user, group]) {
      const meta = ((await res.json()) as { meta: { location: string; version: string } }).meta
      expect(res.headers.get('Location')).toBe(meta.location)
      expect(res.headers.get('ETag')).toBe(meta.version)
    }
  })

  it('never patches a group of another tenant with this tenant token', async () => {
    const harness = await setup()
    const id = await createGroup(harness, 'Private')

    const res = await harness.scim({
      method: 'PATCH',
      path: `/Groups/${id}`,
      tenantId: 't_2',
      token: OTHER_TOKEN,
      body: patchBody({ op: 'replace', path: 'displayName', value: 'Hijacked' }),
    })

    expect(res.status).toBe(404)
    expect((await getJson(harness, `/Groups/${id}`))['displayName']).toBe('Private')
  })
})

describe('SCIM Bulk', () => {
  it('resolves bulkId references inside data to the created resource id', async () => {
    const harness = await setup()

    const res = await harness.scim({
      method: 'POST',
      path: '/Bulk',
      body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          { method: 'POST', path: '/Users', bulkId: 'u1', data: { userName: 'bulk@example.com' } },
          {
            method: 'POST',
            path: '/Groups',
            bulkId: 'g1',
            data: { displayName: 'Bulk', members: [{ value: 'bulkId:u1' }] },
          },
          {
            method: 'POST',
            path: '/Groups',
            data: { displayName: 'Dangling', members: [{ value: 'bulkId:nope' }] },
          },
        ],
      },
    })

    const ops = (
      (await res.json()) as { Operations: { status: string; response: Record<string, unknown> }[] }
    ).Operations
    const userId = ops[0]!.response['id']
    expect(ops[1]!.status).toBe('201')
    expect(ops[1]!.response['members']).toEqual([expect.objectContaining({ value: userId })])
    expect(ops[2]!.status).toBe('409')
  })

  it('stops after failOnErrors errors have accumulated', async () => {
    const harness = await setup()
    const bad = { method: 'POST', path: '/Users', data: {} }

    const res = await harness.scim({
      method: 'POST',
      path: '/Bulk',
      body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        failOnErrors: 2,
        Operations: [
          bad,
          bad,
          { method: 'POST', path: '/Users', data: { userName: 'late@example.com' } },
        ],
      },
    })

    expect(((await res.json()) as { Operations: unknown[] }).Operations).toHaveLength(2)
  })

  it('rejects a non-integer failOnErrors with invalidValue', async () => {
    const harness = await setup()

    const res = await harness.scim({
      method: 'POST',
      path: '/Bulk',
      body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        failOnErrors: true,
        Operations: [{ method: 'DELETE', path: '/Users/x' }],
      },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ scimType: 'invalidValue' })
  })
})
