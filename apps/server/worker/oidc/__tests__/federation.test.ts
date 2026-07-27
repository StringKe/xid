import { describe, expect, it } from 'vitest'
import { registerFederationRoutes } from '../federation'
import { buildTestTenant, makeApp, makeEnv, makeFakeD1, makeFakeKv } from './helpers'

const managerSession = {
  sessionId: 's_mgr',
  userId: 'u_mgr',
  status: 'active' as const,
  activeOrgId: null,
  authenticatedAt: new Date(),
  expiresAt: new Date(Date.now() + 3600_000),
  rememberMe: false,
  isImpersonation: false,
  impersonatorUserId: null,
  acr: null,
  amr: null,
  aal: null,
}

function managerDb() {
  return makeFakeD1({
    users: [
      {
        id: 'u_mgr',
        tenant_id: 't_1',
        primary_email_id: 'email_mgr',
        status: 'active',
        deleted_at: null,
      },
    ],
    user_emails: [
      {
        id: 'email_mgr',
        tenant_id: 't_1',
        user_id: 'u_mgr',
        email: 'manager@example.test',
        verified: 1,
        verification_status: 'verified',
        is_primary: 1,
      },
    ],
    manager_assignments: [
      {
        id: 'mgr_1',
        tenant_id: 't_1',
        user_id: 'u_mgr',
        manager_role: 'instance_manager',
        scope_type: 'instance',
        scope_id: null,
      },
    ],
  })
}

describe('OpenID Federation', () => {
  it('advertises federation metadata publicly', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ CACHE: makeFakeKv() })
    const app = makeApp(ctx, registerFederationRoutes)
    const meta = await app.request('https://acme.xid.dev/.well-known/openid-federation', {}, env)
    expect(meta.status).toBe(200)
    const metaBody = (await meta.json()) as Record<string, unknown>
    expect(metaBody['federation_registration_endpoint']).toBe(
      'https://acme.xid.dev/federation_registration',
    )
  })

  it('requires instance manager auth for federation registration', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ CACHE: makeFakeKv() })
    const app = makeApp(ctx, registerFederationRoutes)
    const unauth = await app.request(
      'https://acme.xid.dev/federation_registration',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entity_id: 'https://anchor.example',
          jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }] },
        }),
      },
      env,
    )
    expect(unauth.status).toBe(401)

    const authedApp = makeApp(ctx, registerFederationRoutes, managerSession)
    const reg = await authedApp.request(
      'https://acme.xid.dev/federation_registration',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entity_id: 'https://anchor.example',
          jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }] },
        }),
      },
      makeEnv({ CACHE: makeFakeKv(), DB: managerDb() }),
    )
    expect(reg.status).toBe(201)
  })
})
