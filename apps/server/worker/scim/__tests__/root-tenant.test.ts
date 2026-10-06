// multi_tenant 实例根域上的 SCIM:按路径中的 organization_id 解析租户,Base URL 对所有租户相同。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import type { XidHonoEnv } from '../../lib/types'
import { makeEnv, makeFakeKv } from '../../oidc/__tests__/helpers'

const resolveTenantContextById = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xid-kit/db')>()),
  resolveTenantContextById,
}))

const { registerScimRoutes } = await import('../index')

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))

function tenantContext(tenantId: string): TenantContext {
  return {
    tenantId,
    issuer: 'https://xid.dev',
    rpId: `${tenantId}.xid.dev`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

const ROOT_ENTRY: TenantContext = {
  ...tenantContext('org_default'),
  rpId: 'xid.dev',
  resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
}

async function setup() {
  const d1 = new SqliteD1()
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    d1.database.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
  const db = d1 as unknown as D1Database
  for (const tenantId of ['t_1', 't_2']) {
    await createTenantDb(db, tenantContext(tenantId)).directories.insert({
      id: `dir_${tenantId}`,
      tenantId,
      orgId: tenantId,
      provider: 'okta',
      scimTokenHash: await sha256Hex(`token_${tenantId}`),
    })
  }
  resolveTenantContextById.mockImplementation(
    async (_request: Request, _env: Env, tenantId: string) =>
      tenantId === 't_1' || tenantId === 't_2'
        ? { ok: true, value: { status: 'resolved', tenant: tenantContext(tenantId) } }
        : { ok: false, error: { code: 'tenant_not_found', httpStatus: 404 } },
  )
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c, next) => {
    c.set('tenant', ROOT_ENTRY)
    c.set('session', null)
    await next()
  })
  registerScimRoutes(app)
  return { app, env: makeEnv({ DB: db, CACHE: makeFakeKv() }) }
}

async function listUsers(
  setupResult: Awaited<ReturnType<typeof setup>>,
  input: { organizationId: string; token: string },
): Promise<Response> {
  return setupResult.app.request(
    `https://xid.dev/scim/v2/organizations/${input.organizationId}/Users`,
    { headers: { Authorization: `Bearer ${input.token}` } },
    setupResult.env,
  )
}

describe('SCIM on the multi-tenant instance root domain', () => {
  it('resolves a non-default tenant from the path and serves its directory', async () => {
    const ctx = await setup()

    const res = await listUsers(ctx, { organizationId: 't_2', token: 'token_t_2' })

    expect(res.status).toBe(200)
    expect(resolveTenantContextById).toHaveBeenCalledWith(expect.anything(), ctx.env, 't_2')
  })

  it('rejects a token from another tenant with 401', async () => {
    const ctx = await setup()

    const res = await listUsers(ctx, { organizationId: 't_2', token: 'token_t_1' })

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('answers an unknown organization exactly like a bad token', async () => {
    const ctx = await setup()

    const unknown = await listUsers(ctx, { organizationId: 'org_missing', token: 'token_t_1' })
    const badToken = await listUsers(ctx, { organizationId: 't_1', token: 'token_wrong' })

    expect(unknown.status).toBe(401)
    expect(badToken.status).toBe(401)
    expect(await unknown.json()).toEqual(await badToken.json())
  })
})
