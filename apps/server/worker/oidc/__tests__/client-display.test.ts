// Hosted Auth 的 client 展示数据与上下文栏:真 SQLite + 全量迁移验证租户隔离与 active 过滤。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TenantContext } from '@xid-kit/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'
import { resolveHostedAuthContext } from '../../auth/hosted-context'
import { registerSessionAuthRoutes } from '../../me-auth/index'
import { execCtx, makeApp, makeEnv, makeSession } from '../../me-auth/__tests__/helpers'
import type { TenantVar } from '../../lib/types'
import { resolveClientDisplay } from '../client-display'

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))
const NOW = Date.now()

let d1: SqliteD1

function applyMigrations(db: SqliteD1): void {
  db.database.exec('PRAGMA foreign_keys = OFF')
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.database.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

function tenantContext(tenantId: string, resolution?: TenantContext['resolution']): TenantContext {
  return {
    tenantId,
    instanceId: 'inst_1',
    issuer: 'https://xid.dev',
    rpId: `${tenantId}.xid.dev`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
    ...(resolution ? { resolution } : {}),
  }
}

function seedTenant(input: { tenantId: string; orgName: string; projectName: string }): void {
  const { tenantId } = input
  d1.database
    .prepare(
      `INSERT INTO organizations (id, tenant_id, instance_id, slug, name, logo_url, created_at, updated_at)
       VALUES (?, ?, 'inst_1', ?, ?, ?, ?, ?)`,
    )
    .run(
      tenantId,
      tenantId,
      tenantId,
      input.orgName,
      `https://cdn.example/${tenantId}.png`,
      NOW,
      NOW,
    )
  d1.database
    .prepare(
      `INSERT INTO projects (id, tenant_id, org_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`proj_${tenantId}`, tenantId, tenantId, input.projectName, NOW, NOW)
}

function seedClient(input: { tenantId: string; clientId: string; status?: string }): void {
  d1.database
    .prepare(
      `INSERT INTO applications (id, tenant_id, project_id, client_id, client_type, token_endpoint_auth_method,
         redirect_uris, allowed_grant_types, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'public', 'none', '["https://rp.example.com/cb"]', '["authorization_code"]', ?, ?, ?)`,
    )
    .run(
      `app_${input.tenantId}_${input.clientId}`,
      input.tenantId,
      `proj_${input.tenantId}`,
      input.clientId,
      input.status ?? 'active',
      NOW,
      NOW,
    )
}

function seedConsent(input: { tenantId: string; userId: string; clientId: string }): void {
  d1.database
    .prepare(
      `INSERT INTO oauth_consents (id, tenant_id, user_id, client_id, granted_scopes, created_at, updated_at)
       VALUES (?, ?, ?, ?, '["openid","email"]', ?, ?)`,
    )
    .run(`consent_${input.tenantId}`, input.tenantId, input.userId, input.clientId, NOW, NOW)
}

function oauthStateWith(pending: Record<string, string>): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'authz' }) as DurableObjectId,
    get: () =>
      ({
        fetch: async (input: string) => {
          if (new URL(input).pathname === '/store') return new Response(null, { status: 201 })
          return Response.json({
            record: { pendingParams: pending, interactionStartedAt: 1_000, viaPar: false },
          })
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

beforeEach(() => {
  d1 = new SqliteD1()
  applyMigrations(d1)
  seedTenant({ tenantId: 't_a', orgName: 'Northwind Logistics', projectName: 'Fleet Planner' })
  seedTenant({ tenantId: 't_b', orgName: 'Contoso', projectName: 'Contoso Portal' })
})

afterEach(() => d1.close())

describe('resolveClientDisplay', () => {
  it('uses the project name and the owning organization for display', async () => {
    const display = await resolveClientDisplay(d1 as unknown as D1Database, tenantContext('t_a'), {
      clientId: 'fleet',
      projectId: 'proj_t_a',
    })

    expect(display).toEqual({
      clientName: 'Fleet Planner',
      clientLogoUrl: 'https://cdn.example/t_a.png',
      ownerOrganizationName: 'Northwind Logistics',
    })
  })

  it('falls back to the client id when the project belongs to another tenant', async () => {
    const display = await resolveClientDisplay(d1 as unknown as D1Database, tenantContext('t_a'), {
      clientId: 'fleet',
      projectId: 'proj_t_b',
    })

    expect(display).toEqual({
      clientName: 'fleet',
      clientLogoUrl: null,
      ownerOrganizationName: null,
    })
  })
})

describe('resolveHostedAuthContext', () => {
  it('names the organization and the active application of the resolved tenant', async () => {
    seedClient({ tenantId: 't_a', clientId: 'fleet' })

    const context = await resolveHostedAuthContext(
      d1 as unknown as D1Database,
      tenantContext('t_a'),
      'fleet',
    )

    expect(context).toEqual({
      organizationName: 'Northwind Logistics',
      applicationName: 'Fleet Planner',
      applicationLogoUrl: 'https://cdn.example/t_a.png',
    })
  })

  it('returns no organization name at the instance root entry', async () => {
    const root = tenantContext('t_a', {
      kind: 'instance_entry',
      primaryDomain: 'xid.dev',
      unresolvedRoot: true,
    })

    const context = await resolveHostedAuthContext(d1 as unknown as D1Database, root, null)

    expect(context).toEqual({
      organizationName: null,
      applicationName: null,
      applicationLogoUrl: null,
    })
  })

  it('returns no application for a disabled client', async () => {
    seedClient({ tenantId: 't_a', clientId: 'fleet', status: 'disabled' })

    const context = await resolveHostedAuthContext(
      d1 as unknown as D1Database,
      tenantContext('t_a'),
      'fleet',
    )

    expect(context.applicationName).toBeNull()
    expect(context.applicationLogoUrl).toBeNull()
  })

  it('returns no application for a client registered in another tenant', async () => {
    seedClient({ tenantId: 't_b', clientId: 'portal' })

    const context = await resolveHostedAuthContext(
      d1 as unknown as D1Database,
      tenantContext('t_a'),
      'portal',
    )

    expect(context).toEqual({
      organizationName: 'Northwind Logistics',
      applicationName: null,
      applicationLogoUrl: null,
    })
  })
})

describe('GET /auth/consent-params previously granted scopes', () => {
  async function consentParams(
    tenantId: string,
    clientId: string,
  ): Promise<Record<string, unknown>> {
    const pending = {
      client_id: clientId,
      redirect_uri: 'https://rp.example.com/cb',
      scope: 'openid email profile',
      response_type: 'code',
    }
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantContext(tenantId) as TenantVar,
      session: makeSession('user-1'),
    })
    const env = {
      ...makeEnv({ oauthStateNs: oauthStateWith(pending) }),
      DB: d1 as unknown as D1Database,
    }
    const res = await app.request('/auth/consent-params?prompt_id=p1', {}, env, execCtx)
    expect(res.status).toBe(200)
    return (await res.json()) as Record<string, unknown>
  }

  it('returns the scopes this user already granted to this client in this tenant', async () => {
    seedClient({ tenantId: 't_a', clientId: 'fleet' })
    seedConsent({ tenantId: 't_a', userId: 'user-1', clientId: 'fleet' })

    const body = await consentParams('t_a', 'fleet')

    expect(body['previouslyGrantedScopes']).toEqual(['openid', 'email'])
    expect(body['ownerOrganizationName']).toBe('Northwind Logistics')
    expect(body['redirectOrigin']).toBe('https://rp.example.com')
  })

  it('does not reveal a consent row stored under another tenant for the same user and client', async () => {
    seedClient({ tenantId: 't_b', clientId: 'portal' })
    seedConsent({ tenantId: 't_a', userId: 'user-1', clientId: 'portal' })

    const body = await consentParams('t_b', 'portal')

    expect(body['previouslyGrantedScopes']).toEqual([])
    expect(body['clientName']).toBe('Contoso Portal')
  })
})
