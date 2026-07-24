// Enterprise legacy protocol route tests: LDAP, WS-Fed, SWA, header-based SSO, directory connectors.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HostedAuthPolicy } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { envelopeEncrypt, sha256Hex } from '@xid-kit/crypto'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { AppError, isAppError } from '../../lib/errors'
import { registerLdapRoutes } from '../ldap'
import { registerWsfedRoutes } from '../wsfed'
import { registerSwaRoutes } from '../swa'
import { registerDirectoryConnectorRoutes } from '../directory-connector'
import { buildFakeWresult, storeFakeWsfedState } from '../../test-harness/fake-wsfed'
import { decodeKek } from '../../oidc/shared'

const mockSsoConnectionsFindOne = vi.fn()
const mockSsoConnectionsUpdate = vi.fn()
const mockJitProvision = vi.fn()
const mockIssueSession = vi.fn()
const mockShouldRequireMfa = vi.fn()
const mockRequireApiKeyOrOrgManager = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    ssoConnections: {
      findOne: mockSsoConnectionsFindOne,
      update: mockSsoConnectionsUpdate,
    },
  })),
  resolveTenantContextBySsoConnection: vi.fn(),
  schema: {
    ssoConnections: { id: 'id', status: 'status' },
  },
}))

vi.mock('../jit', () => ({
  jitProvision: (...args: unknown[]) => mockJitProvision(...args),
}))

vi.mock('../../lib/session', () => ({
  issueSession: (...args: unknown[]) => mockIssueSession(...args),
}))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return {
    ...actual,
    resolvePostAuthMfaGate: (...args: unknown[]) => mockShouldRequireMfa(...args),
  }
})

vi.mock('../../v1/shared', () => ({
  requireApiKeyOrOrgManager: (...args: unknown[]) => mockRequireApiKeyOrOrgManager(...args),
}))

import { resolveTenantContextBySsoConnection } from '@xid-kit/db'

const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
  }
  return c.json({ code: 'server_error' }, 500)
}

const ENTERPRISE_SSO_ENABLED: HostedAuthPolicy = {
  ...DEFAULT_HOSTED_AUTH_POLICY,
  enterpriseSso: {
    enabled: true,
    allowLogin: true,
    allowJitUserCreation: true,
    domainDiscovery: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
  },
}

const INSTANCE_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x41)))

function makeConnection(protocol: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    tenantId: 'tenant-1',
    orgId: 'org-1',
    protocol,
    status: 'active',
    idpSsoUrl: 'https://fake-idp.example.com/wsfed/login',
    attributeMapping: {
      _legacy: {
        trustedProxySecret: 'proxy-secret',
        ldapGatewayUrl: 'https://ldap-gw.example.com/bind',
      },
      _swaVault: {
        'vault.user@example.com': {
          username: 'vault.user@example.com',
          passwordHash: '4f8e2f1f0f6d9db7d2f0d5f2d2f0d5f2d2f0d5f2d2f0d5f2d2f0d5f2d2f',
          email: 'vault.user@example.com',
        },
      },
    },
    ...overrides,
  }
}

async function makeEnvelopeVault(password: string) {
  const hash = await sha256Hex(password)
  const encrypted = await envelopeEncrypt(
    new TextEncoder().encode(
      JSON.stringify({
        'vault.user@example.com': {
          username: 'vault.user@example.com',
          passwordHash: hash,
          email: 'vault.user@example.com',
        },
      }),
    ),
    decodeKek(INSTANCE_KEK),
    1,
  )
  return {
    iv: btoa(String.fromCharCode(...encrypted.iv)),
    ciphertext: btoa(String.fromCharCode(...encrypted.ciphertext)),
    tag: btoa(String.fromCharCode(...encrypted.tag)),
    kekVersion: encrypted.kekVersion,
  }
}

function buildApp() {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId: 'tenant-1',
      issuer: 'https://tenant-1.xid.dev',
      rpId: 'tenant-1.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: { hostedAuth: ENTERPRISE_SSO_ENABLED },
    })
    await next()
  })
  registerLdapRoutes(app)
  registerWsfedRoutes(app)
  registerSwaRoutes(app)
  registerDirectoryConnectorRoutes(app)
  return app
}

const fakeEnv = {
  DB: {},
  ENVIRONMENT: 'test',
  KEK: INSTANCE_KEK,
} as unknown as Env

const productionEnv = {
  DB: {},
  ENVIRONMENT: 'production',
  KEK: INSTANCE_KEK,
} as unknown as Env

describe('enterprise legacy protocols', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveTenantContextBySsoConnection).mockResolvedValue({
      ok: true,
      value: {
        tenant: {
          tenantId: 'tenant-1',
          issuer: 'https://tenant-1.xid.dev',
          rpId: 'tenant-1.xid.dev',
          signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
          policy: { hostedAuth: ENTERPRISE_SSO_ENABLED },
        },
      },
    } as never)
    mockJitProvision.mockResolvedValue({ userId: 'user-legacy', provisioned: true })
    mockIssueSession.mockResolvedValue({})
    mockShouldRequireMfa.mockResolvedValue({})
    mockRequireApiKeyOrOrgManager.mockResolvedValue({
      kind: 'org_console',
      session: { userId: 'admin-1' },
    })
    mockSsoConnectionsUpdate.mockResolvedValue([makeConnection('swa')])
  })

  it('lists directory connector types', async () => {
    const app = buildApp()
    const res = await app.request('/sso/directory-connectors/types', {}, fakeEnv)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connectors: Array<{ key: string }> }
    expect(body.connectors.some((item) => item.key === 'header_sso')).toBe(true)
    expect(body.connectors.some((item) => item.key === 'ldap_bind')).toBe(true)
  })

  it('LDAP login succeeds with fake harness user', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('ldap'))
    const app = buildApp()
    const res = await app.request(
      '/sso/ldap/conn-1/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ldap.user@example.com', password: 'ldap-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(302)
    expect(mockJitProvision).toHaveBeenCalled()
  })

  it('LDAP login rejects invalid credentials', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('ldap'))
    const app = buildApp()
    const res = await app.request(
      '/sso/ldap/conn-1/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ldap.user@example.com', password: 'wrong' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(401)
  })

  it('LDAP login enforces tenant isolation on unknown connection', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(null)
    const app = buildApp()
    const res = await app.request(
      '/sso/ldap/other-tenant/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ldap.user@example.com', password: 'ldap-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(404)
  })

  it('WS-Fed login redirects to configured IdP SSO URL', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('wsfed'))
    const app = buildApp()
    const res = await app.request('/sso/wsfed/conn-1/login', {}, fakeEnv)
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('https://fake-idp.example.com/wsfed/login')
    expect(location).toContain('wa=wsignin1.0')
    expect(location).toContain('xid_fake_wsfed=1')
  })

  it('WS-Fed callback parses wresult and issues session', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('wsfed'))
    const wresult = buildFakeWresult('wsfed.user@example.com')
    const app = buildApp()
    const res = await app.request(
      `/sso/wsfed/conn-1/callback?wresult=${encodeURIComponent(wresult)}`,
      {},
      fakeEnv,
    )
    expect(res.status).toBe(302)
    expect(mockJitProvision).toHaveBeenCalled()
  })

  it('WS-Fed callback can consume fake harness state', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('wsfed'))
    storeFakeWsfedState('state-123', 'wsfed.user@example.com')
    const app = buildApp()
    const res = await app.request('/sso/wsfed/conn-1/callback?wctx=state-123', {}, fakeEnv)
    expect(res.status).toBe(302)
  })

  it('WS-Fed callback 超大 wresult -> 400 invalid_request', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('wsfed'))
    const app = buildApp()
    const res = await app.request(
      `/sso/wsfed/conn-1/callback?wresult=${'A'.repeat(257 * 1024)}`,
      {},
      fakeEnv,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('invalid_request')
  })

  it('WS-Fed callback rejects unsigned wresult in production', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('wsfed', { idpCertificates: [] }))
    const wresult = buildFakeWresult('wsfed.user@example.com')
    const app = buildApp()
    const res = await app.request(
      `/sso/wsfed/conn-1/callback?wresult=${encodeURIComponent(wresult)}`,
      {},
      productionEnv,
    )
    expect(res.status).toBe(400)
  })

  it('WS-Fed callback enforces tenant isolation on unknown connection', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(null)
    const wresult = buildFakeWresult('wsfed.user@example.com')
    const app = buildApp()
    const res = await app.request(
      `/sso/wsfed/other-tenant/callback?wresult=${encodeURIComponent(wresult)}`,
      {},
      fakeEnv,
    )
    expect(res.status).toBe(404)
  })

  it('SWA authenticate succeeds with fake harness user', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('swa'))
    const app = buildApp()
    const res = await app.request(
      '/sso/swa/conn-1/authenticate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'swa.user@example.com', password: 'swa-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(302)
  })

  it('SWA authenticate accepts form POST credentials', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('swa'))
    const app = buildApp()
    const res = await app.request(
      '/sso/swa/conn-1/authenticate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: 'swa.user@example.com',
          password: 'swa-pass',
        }).toString(),
      },
      fakeEnv,
    )
    expect(res.status).toBe(302)
  })

  it('SWA authenticate succeeds with vaulted credentials', async () => {
    const passwordHash = await sha256Hex('vault-pass')
    mockSsoConnectionsFindOne.mockResolvedValue(
      makeConnection('swa', {
        attributeMapping: {
          _swaVault: {
            'vault.user@example.com': {
              username: 'vault.user@example.com',
              passwordHash,
              email: 'vault.user@example.com',
            },
          },
        },
      }),
    )
    const app = buildApp()
    const res = await app.request(
      '/sso/swa/conn-1/authenticate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'vault.user@example.com', password: 'vault-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(302)
  })

  it('SWA authenticate reads envelope-encrypted vault credentials', async () => {
    const envelope = await makeEnvelopeVault('vault-pass')
    mockSsoConnectionsFindOne.mockResolvedValue(
      makeConnection('swa', {
        attributeMapping: {
          _swaVaultEnvelope: envelope,
        },
      }),
    )
    const app = buildApp()
    const res = await app.request(
      '/sso/swa/conn-1/authenticate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'vault.user@example.com', password: 'vault-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(302)
  })

  it('SWA vault rejects unauthenticated writes', async () => {
    mockRequireApiKeyOrOrgManager.mockRejectedValueOnce(
      new AppError('unauthorized', { httpStatus: 401 }),
    )
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('swa'))
    const app = buildApp()
    const res = await app.request(
      '/sso/swa/conn-1/vault',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'vault.user@example.com', password: 'vault-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(401)
    expect(mockRequireApiKeyOrOrgManager).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'connections:write',
    )
  })

  it('SWA vault stores credentials when org manager is authenticated', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('swa'))
    const app = buildApp()
    const res = await app.request(
      '/sso/swa/conn-1/vault',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'vault.user@example.com', password: 'vault-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(200)
    expect(mockRequireApiKeyOrOrgManager).toHaveBeenCalled()
    expect(mockSsoConnectionsUpdate).toHaveBeenCalled()
    const updateArg = mockSsoConnectionsUpdate.mock.calls[0]?.[0] as {
      attributeMapping: Record<string, unknown>
    }
    expect(updateArg.attributeMapping._swaVaultEnvelope).toBeTruthy()
    expect(updateArg.attributeMapping._swaVault).toBeUndefined()
  })

  it('SWA authenticate enforces tenant isolation on unknown connection', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(null)
    const app = buildApp()
    const res = await app.request(
      '/sso/swa/other-tenant/authenticate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'swa.user@example.com', password: 'swa-pass' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(404)
  })

  it('header-based SSO requires trusted proxy secret when configured', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('header'))
    const app = buildApp()
    const denied = await app.request(
      '/sso/header/conn-1/authenticate',
      {
        method: 'POST',
        headers: {
          'X-Remote-User': 'header.user@example.com',
          'X-Remote-Email': 'header.user@example.com',
        },
      },
      fakeEnv,
    )
    expect(denied.status).toBe(401)

    const allowed = await app.request(
      '/sso/header/conn-1/authenticate',
      {
        method: 'POST',
        headers: {
          'X-Remote-User': 'header.user@example.com',
          'X-Remote-Email': 'header.user@example.com',
          'X-Trusted-Proxy-Secret': 'proxy-secret',
        },
      },
      fakeEnv,
    )
    expect(allowed.status).toBe(302)
  })

  it('header-based SSO rejects connections without trusted proxy secret', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(
      makeConnection('header', {
        attributeMapping: {
          _legacy: {},
        },
      }),
    )
    const app = buildApp()
    const res = await app.request(
      '/sso/header/conn-1/authenticate',
      {
        method: 'POST',
        headers: {
          'X-Remote-User': 'header.user@example.com',
          'X-Remote-Email': 'header.user@example.com',
          'X-Trusted-Proxy-Secret': 'proxy-secret',
        },
      },
      fakeEnv,
    )
    expect(res.status).toBe(401)
  })

  it('header-based SSO enforces tenant isolation on unknown connection', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(null)
    const app = buildApp()
    const res = await app.request(
      '/sso/header/other-tenant/authenticate',
      {
        method: 'POST',
        headers: {
          'X-Remote-User': 'header.user@example.com',
          'X-Trusted-Proxy-Secret': 'proxy-secret',
        },
      },
      fakeEnv,
    )
    expect(res.status).toBe(404)
  })

  it('directory connector validate returns implemented connector status', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection('header'))
    const app = buildApp()
    const res = await app.request(
      '/sso/directory-connectors/conn-1/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorKey: 'header_sso' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { valid: boolean; connector: string }
    expect(body.valid).toBe(true)
    expect(body.connector).toBe('header_sso')
  })

  it('directory connector validate rejects unknown connector key', async () => {
    const app = buildApp()
    const res = await app.request(
      '/sso/directory-connectors/conn-1/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorKey: 'missing' }),
      },
      fakeEnv,
    )
    expect(res.status).toBe(400)
  })
})
