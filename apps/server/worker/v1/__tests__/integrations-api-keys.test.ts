// /v1/api-keys 创建者记录与可授予 scope:cookie 会话记 userId、API key 调用记 keyId,
// grantable-scopes 不超出调用方自身 scope;另覆盖组织目录列表的 groupCount。

import { describe, expect, it, vi } from 'vitest'
import { schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { API_KEY_SCOPE_RESOURCES } from '@xid-kit/types'
import type { Hono } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { registerApiKeys } from '../api-keys'
import { registerOrganizationDirectoryRoutes } from '../organization-directories'
import {
  buildApp,
  envOf,
  json,
  makeDb,
  seedApiKey,
  seedMembership,
  seedOrg,
  seedUser,
  sessionFor,
  tenantDb,
} from './console-fixtures'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const BASE = 'https://acme.xid.dev/v1/api-keys'

type KeyRow = {
  id: string
  name: string
  createdBy: { kind: string; id: string; displayName: string | null } | null
}

async function seedTenant() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  await seedUser(d1, { id: 'user_dana', firstName: 'Dana' })
  await seedMembership(d1, { id: 'mem_dana', userId: 'user_dana', orgId: 't_a', role: 'admin' })
  return d1
}

function post(app: Hono<XidHonoEnv>, env: Env, body: unknown, token?: string) {
  return app.request(
    BASE,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe('POST /v1/api-keys created_by', () => {
  it('records the signed-in organization admin as the creator', async () => {
    const d1 = await seedTenant()
    const app = buildApp(registerApiKeys, { session: sessionFor('user_dana') })
    const env = envOf(d1)

    const res = await post(app, env, { name: 'Fleet sync', scopes: ['users:read'] })
    const created = await json<KeyRow>(res)
    const list = await json<{ data: KeyRow[] }>(await app.request(BASE, {}, env))
    const stored = await tenantDb(d1).apiKeys.findOne(eq(schema.apiKeys.id, created.id))

    expect(res.status).toBe(201)
    expect(stored?.createdBy).toBe('user_dana')
    expect(list.data.find((row) => row.id === created.id)?.createdBy).toEqual({
      kind: 'user',
      id: 'user_dana',
      displayName: 'Dana',
    })
  })

  it('records the calling API key as the creator', async () => {
    const d1 = await seedTenant()
    const token = await seedApiKey(d1, {
      id: 'ak_root',
      scopes: ['api_keys:read', 'api_keys:write', 'users:read'],
    })
    const app = buildApp(registerApiKeys)
    const env = envOf(d1)

    const created = await json<KeyRow>(
      await post(app, env, { name: 'CI provisioning', scopes: ['users:read'] }, token),
    )

    expect(created.createdBy).toEqual({ kind: 'api_key', id: 'ak_root', displayName: 'test' })
  })

  it('refuses to mint a key wider than the calling key', async () => {
    const d1 = await seedTenant()
    const token = await seedApiKey(d1, {
      id: 'ak_narrow',
      scopes: ['api_keys:write', 'users:read'],
    })
    const app = buildApp(registerApiKeys)
    const env = envOf(d1)

    const res = await post(app, env, { name: 'Escalation', scopes: ['users:write'] }, token)

    expect(res.status).toBe(422)
    expect(await tenantDb(d1).apiKeys.count()).toBe(1)
  })
})

describe('GET /v1/api-keys/grantable-scopes', () => {
  it('limits an API key caller to the scopes it holds', async () => {
    const d1 = await seedTenant()
    const token = await seedApiKey(d1, { id: 'ak_narrow', scopes: ['api_keys:read', 'users:*'] })
    const app = buildApp(registerApiKeys)

    const res = await app.request(
      `${BASE}/grantable-scopes`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(d1),
    )

    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      scopes: ['api_keys:read', 'users:read', 'users:write'],
      fullAccess: false,
    })
  })

  it('offers every scope to an organization admin session', async () => {
    const d1 = await seedTenant()
    const app = buildApp(registerApiKeys, { session: sessionFor('user_dana') })

    const body = await json<{ scopes: string[]; fullAccess: boolean }>(
      await app.request(`${BASE}/grantable-scopes`, {}, envOf(d1)),
    )

    expect(body.fullAccess).toBe(true)
    expect(body.scopes).toHaveLength(API_KEY_SCOPE_RESOURCES.length * 2)
  })

  it('rejects a key without api_keys:read', async () => {
    const d1 = await seedTenant()
    const token = await seedApiKey(d1, { id: 'ak_users', scopes: ['users:read'] })
    const app = buildApp(registerApiKeys)

    const res = await app.request(
      `${BASE}/grantable-scopes`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(d1),
    )

    expect(res.status).toBe(403)
  })
})

describe('GET /v1/organizations/:id/directories groupCount', () => {
  it('counts the live groups of each directory', async () => {
    const d1 = await seedTenant()
    const db = tenantDb(d1)
    await db.directories.insert({
      id: 'dir_okta',
      tenantId: 't_a',
      orgId: 't_a',
      provider: 'okta',
      scimTokenHash: 'hash',
      status: 'active',
    })
    for (const [id, status] of [
      ['dgrp_1', 'active'],
      ['dgrp_2', 'active'],
      ['dgrp_3', 'deleted'],
    ] as const) {
      await db.directoryGroups.insert({
        id,
        tenantId: 't_a',
        directoryId: 'dir_okta',
        displayName: id,
        status,
      })
    }
    const app = buildApp(
      (parent) => {
        registerOrganizationDirectoryRoutes(parent)
      },
      { session: sessionFor('user_dana') },
    )

    const res = await app.request('https://acme.xid.dev/t_a/directories', {}, envOf(d1))
    const body = await json<{ id: string; groupCount: number }[]>(res)

    expect(res.status).toBe(200)
    expect(body).toEqual([expect.objectContaining({ id: 'dir_okta', groupCount: 2 })])
  })
})
