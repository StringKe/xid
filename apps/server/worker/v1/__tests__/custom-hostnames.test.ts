import type { TenantContext } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudflareCustomHostnameDetails,
  CloudflareCustomHostnamesClientLike,
} from '../../lib/cloudflare-custom-hostnames'
import { CloudflareCustomHostnameError } from '../../lib/cloudflare-custom-hostnames'
import { isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import { registerCustomHostnameRoutes } from '../custom-hostnames'

const mocks = vi.hoisted(() => {
  const customHostnames = {
    findMany: vi.fn(),
    findOne: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
  }
  const orgDb = { customHostnames }
  const tenantDb = {
    customHostnames,
    forOrg: vi.fn(() => orgDb),
  }
  return {
    customHostnames,
    orgDb,
    tenantDb,
    requireApiKeyOrOrgManager: vi.fn(),
    persistCustomHostnameStateWithAudit: vi.fn(),
  }
})

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    createTenantDb: vi.fn(() => mocks.tenantDb),
  }
})

vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>()
  return {
    ...actual,
    requireApiKeyOrOrgManager: mocks.requireApiKeyOrOrgManager,
  }
})

vi.mock('../../custom-hostnames/audited-state', () => ({
  persistCustomHostnameStateWithAudit: mocks.persistCustomHostnameStateWithAudit,
}))

type Row = {
  id: string
  tenantId: string
  orgId: string
  instanceId: string
  hostname: string
  cloudflareHostnameId: string | null
  status: string
  hostnameStatus: string
  sslStatus: string | null
  ownershipVerificationType: string | null
  ownershipVerificationName: string | null
  ownershipVerificationValue: string | null
  ownershipExpiresAt: Date | null
  dcvDelegationRecords: Array<{ cname: string; cnameTarget: string }>
  validationRecords: Array<Record<string, string>>
  trafficCnameTarget: string
  verificationErrors: string[]
  requiresPasskeyReregistration: boolean
  activatedAt: Date | null
  lastPolledAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const TENANT: TenantContext = {
  tenantId: 'tenant_1',
  instanceId: 'inst_1',
  issuer: 'https://xid.test',
  hostedAuthOrigin: 'https://acme.xid.test',
  rpId: 'acme.xid.test',
  resolution: { kind: 'tenant', primaryDomain: 'xid.test' },
  signingKeys: { activeKid: 'kid_1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function row(overrides: Partial<Row> = {}): Row {
  const now = new Date('2026-07-28T00:00:00.000Z')
  return {
    id: 'ch_1',
    tenantId: 'tenant_1',
    orgId: 'org_1',
    instanceId: 'inst_1',
    hostname: 'login.customer.example',
    cloudflareHostnameId: 'cf_hostname_1',
    status: 'pending',
    hostnameStatus: 'pending',
    sslStatus: 'pending_validation',
    ownershipVerificationType: 'txt',
    ownershipVerificationName: '_cf-custom-hostname.login.customer.example',
    ownershipVerificationValue: 'ownership-value',
    ownershipExpiresAt: new Date('2026-07-29T00:00:00.000Z'),
    dcvDelegationRecords: [
      {
        cname: '_acme-challenge.login.customer.example',
        cnameTarget: 'login.customer.example.dcv.cloudflare.com',
      },
    ],
    validationRecords: [],
    trafficCnameTarget: 'customers.xid.test',
    verificationErrors: [],
    requiresPasskeyReregistration: true,
    activatedAt: null,
    lastPolledAt: now,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function details(
  overrides: Partial<CloudflareCustomHostnameDetails> = {},
): CloudflareCustomHostnameDetails {
  return {
    id: 'cf_hostname_1',
    hostname: 'login.customer.example',
    status: 'pending',
    sslStatus: 'pending_validation',
    ownershipVerification: {
      type: 'txt',
      name: '_cf-custom-hostname.login.customer.example',
      value: 'ownership-value',
    },
    dcvDelegationRecords: [
      {
        cname: '_acme-challenge.login.customer.example',
        cnameTarget: 'login.customer.example.dcv.cloudflare.com',
      },
    ],
    validationRecords: [],
    verificationErrors: [],
    ...overrides,
  }
}

function client(
  overrides: Partial<CloudflareCustomHostnamesClientLike> = {},
): CloudflareCustomHostnamesClientLike {
  return {
    create: vi.fn(),
    get: vi.fn(),
    findByHostname: vi.fn(),
    delete: vi.fn(),
    trafficCnameTarget: vi.fn(async () => 'customers.xid.test'),
    ...overrides,
  }
}

function buildApp(customClient: CloudflareCustomHostnamesClientLike): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) {
      return c.json({ code: error.code, meta: error.meta }, error.httpStatus as 400)
    }
    throw error
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', TENANT)
    c.set('session', null)
    await next()
  })
  registerCustomHostnameRoutes(app, { clientFactory: () => customClient })
  return app
}

function env() {
  return {
    DB: {},
    AUDIT_QUEUE: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

async function request(
  app: Hono<XidHonoEnv>,
  environment: Env,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return app.request(`https://acme.xid.test${path}`, init, environment)
}

describe('custom hostname Management API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireApiKeyOrOrgManager.mockResolvedValue({
      kind: 'org_console',
      role: 'owner',
      session: { userId: 'user_1' },
    })
    mocks.persistCustomHostnameStateWithAudit.mockImplementation(
      async (
        _environment: Env,
        input: {
          row: Row
          patch: Partial<Row>
        },
      ) => ({
        ...input.row,
        ...input.patch,
        updatedAt: new Date(),
      }),
    )
  })

  it('creates a globally reserved hostname and returns all required DNS records', async () => {
    const reservation = row({
      cloudflareHostnameId: null,
      status: 'provisioning',
      hostnameStatus: 'pending',
      ownershipVerificationType: null,
      ownershipVerificationName: null,
      ownershipVerificationValue: null,
      ownershipExpiresAt: null,
      dcvDelegationRecords: [],
      lastPolledAt: null,
    })
    const validationRecords = [
      {
        txtName: '_acme-challenge.login.customer.example',
        txtValue: 'certificate-value',
      },
    ]
    const created = row({ validationRecords })
    mocks.customHostnames.findOne.mockResolvedValue(undefined)
    mocks.customHostnames.insert.mockResolvedValue(reservation)
    mocks.customHostnames.update.mockResolvedValue([created])
    const create = vi.fn(async () => details({ validationRecords }))
    const customClient = client({ create })
    const environment = env()

    const response = await request(
      buildApp(customClient),
      environment,
      '/v1/organizations/org_1/custom-hostnames',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: 'LOGIN.Customer.Example' }),
      },
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      id: 'ch_1',
      organization_id: 'org_1',
      hostname: 'login.customer.example',
      requires_passkey_reregistration: true,
      dns_records: {
        ownership: {
          type: 'TXT',
          name: '_cf-custom-hostname.login.customer.example',
          value: 'ownership-value',
        },
        dcv_delegation: [
          {
            type: 'CNAME',
            name: '_acme-challenge.login.customer.example',
            value: 'login.customer.example.dcv.cloudflare.com',
          },
        ],
        certificate_validation: [
          {
            type: 'TXT',
            name: '_acme-challenge.login.customer.example',
            value: 'certificate-value',
          },
        ],
        traffic: {
          type: 'CNAME',
          name: 'login.customer.example',
          value: 'customers.xid.test',
        },
      },
    })
    expect(mocks.requireApiKeyOrOrgManager).toHaveBeenCalledWith(
      expect.anything(),
      'org_1',
      'custom_hostnames:write',
    )
    expect(mocks.tenantDb.forOrg).toHaveBeenCalledWith('org_1')
    expect(mocks.customHostnames.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        orgId: 'org_1',
        instanceId: 'inst_1',
        hostname: 'login.customer.example',
        trafficCnameTarget: 'customers.xid.test',
      }),
    )
    expect(create).toHaveBeenCalledWith('login.customer.example')
    expect(mocks.persistCustomHostnameStateWithAudit).toHaveBeenCalledWith(
      environment,
      expect.objectContaining({
        action: 'custom_hostname.created',
        actorId: 'user_1',
        row: reservation,
      }),
    )
  })

  it('maps a cross-tenant global hostname reservation conflict to an opaque 409', async () => {
    mocks.customHostnames.findOne.mockResolvedValue(undefined)
    mocks.customHostnames.insert.mockRejectedValue(
      new Error('UNIQUE constraint failed: custom_hostnames.hostname'),
    )
    const create = vi.fn()
    const customClient = client({ create })

    const response = await request(
      buildApp(customClient),
      env(),
      '/v1/organizations/org_1/custom-hostnames',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: 'login.customer.example' }),
      },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      code: 'already_exists',
      meta: { paramName: 'hostname' },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('reconciles an ambiguous create failure by exact hostname before returning', async () => {
    const reservation = row({
      cloudflareHostnameId: null,
      status: 'provisioning',
      ownershipVerificationType: null,
      ownershipVerificationName: null,
      ownershipVerificationValue: null,
    })
    mocks.customHostnames.findOne.mockResolvedValue(undefined)
    mocks.customHostnames.insert.mockResolvedValue(reservation)
    mocks.customHostnames.update.mockResolvedValue([row()])
    const create = vi.fn(async () => {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_network')
    })
    const findByHostname = vi.fn(async () => details())

    const response = await request(
      buildApp(client({ create, findByHostname })),
      env(),
      '/v1/organizations/org_1/custom-hostnames',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: 'login.customer.example' }),
      },
    )

    expect(response.status).toBe(201)
    expect(findByHostname).toHaveBeenCalledWith('login.customer.example')
    expect(mocks.customHostnames.hardDelete).not.toHaveBeenCalled()
  })

  it('retains an expiring reservation when create and reconciliation are both unavailable', async () => {
    const reservation = row({
      cloudflareHostnameId: null,
      status: 'provisioning',
      ownershipVerificationType: null,
      ownershipVerificationName: null,
      ownershipVerificationValue: null,
    })
    mocks.customHostnames.findOne.mockResolvedValue(undefined)
    mocks.customHostnames.insert.mockResolvedValue(reservation)
    mocks.customHostnames.update.mockResolvedValue([
      row({ status: 'provisioning_failed', cloudflareHostnameId: null }),
    ])
    const create = vi.fn(async () => {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_network')
    })
    const findByHostname = vi.fn(async () => {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_network')
    })

    const response = await request(
      buildApp(client({ create, findByHostname })),
      env(),
      '/v1/organizations/org_1/custom-hostnames',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: 'login.customer.example' }),
      },
    )

    expect(response.status).toBe(503)
    expect(mocks.customHostnames.update).toHaveBeenCalledWith(
      { status: 'provisioning_failed' },
      expect.anything(),
    )
    expect(mocks.customHostnames.hardDelete).not.toHaveBeenCalled()
  })

  it('keeps the local binding when Cloudflare deletion fails', async () => {
    const current = row()
    mocks.customHostnames.findOne.mockResolvedValue(current)
    mocks.customHostnames.update.mockResolvedValue([row({ status: 'deletion_failed' })])
    const removeRemote = vi.fn(async () => {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_network')
    })
    const environment = env()

    const response = await request(
      buildApp(client({ delete: removeRemote })),
      environment,
      '/v1/organizations/org_1/custom-hostnames/ch_1',
      { method: 'DELETE' },
    )

    expect(response.status).toBe(503)
    expect(removeRemote).toHaveBeenCalledWith('cf_hostname_1')
    expect(mocks.customHostnames.update).toHaveBeenCalledWith(
      { status: 'deletion_failed' },
      expect.anything(),
    )
    expect(mocks.persistCustomHostnameStateWithAudit).not.toHaveBeenCalled()
  })

  it('deletes remotely before marking the local row deleted', async () => {
    const current = row()
    mocks.customHostnames.findOne.mockResolvedValue(current)
    const calls: string[] = []
    const removeRemote = vi.fn(async () => {
      calls.push('remote')
    })
    mocks.persistCustomHostnameStateWithAudit.mockImplementationOnce(
      async (_environment, input) => {
        calls.push('local')
        return { ...input.row, ...input.patch, updatedAt: new Date() }
      },
    )
    const environment = env()

    const response = await request(
      buildApp(client({ delete: removeRemote })),
      environment,
      '/v1/organizations/org_1/custom-hostnames/ch_1',
      { method: 'DELETE' },
    )

    expect(response.status).toBe(200)
    expect(calls).toEqual(['remote', 'local'])
    await expect(response.json()).resolves.toEqual({
      id: 'ch_1',
      status: 'deleted',
      remove_dns_record: {
        type: 'CNAME',
        name: 'login.customer.example',
        value: 'customers.xid.test',
      },
    })
    expect(mocks.persistCustomHostnameStateWithAudit).toHaveBeenCalledWith(
      environment,
      expect.objectContaining({
        action: 'custom_hostname.deleted',
        actorId: 'user_1',
      }),
    )
  })

  it('refreshes state through the durable audit outbox', async () => {
    const current = row()
    const refreshed = details({ status: 'active', sslStatus: 'active' })
    mocks.customHostnames.findOne.mockResolvedValue(current)
    const environment = env()

    const response = await request(
      buildApp(client({ get: vi.fn(async () => refreshed) })),
      environment,
      '/v1/organizations/org_1/custom-hostnames/ch_1/refresh',
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(mocks.persistCustomHostnameStateWithAudit).toHaveBeenCalledWith(
      environment,
      expect.objectContaining({
        row: current,
        action: 'custom_hostname.refreshed',
        actorId: 'user_1',
        patch: expect.objectContaining({
          status: 'active',
          hostnameStatus: 'active',
          sslStatus: 'active',
        }),
      }),
    )
  })

  it('refuses to apply a refresh response for a different remote hostname', async () => {
    mocks.customHostnames.findOne.mockResolvedValue(row())
    const get = vi.fn(async () => details({ hostname: 'attacker.customer.example' }))

    const response = await request(
      buildApp(client({ get })),
      env(),
      '/v1/organizations/org_1/custom-hostnames/ch_1/refresh',
      { method: 'POST' },
    )

    expect(response.status).toBe(503)
    expect(mocks.customHostnames.update).not.toHaveBeenCalled()
  })
})
