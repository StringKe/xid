import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloudflareCustomHostnameError,
  type CloudflareCustomHostnameDetails,
  type CloudflareCustomHostnamesClientLike,
} from '../../lib/cloudflare-custom-hostnames'
import { maintainCustomHostnames } from '../custom-hostnames'

const mocks = vi.hoisted(() => {
  const selectLimit = vi.fn()
  const persistState = vi.fn(
    async (
      _env: unknown,
      input: { row: Record<string, unknown>; patch: Record<string, unknown> },
    ) => ({
      ...input.row,
      ...input.patch,
    }),
  )
  const releaseState = vi.fn(async () => undefined)
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: selectLimit,
          })),
        })),
      })),
    })),
  }
  return { db, selectLimit, persistState, releaseState }
})

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => mocks.db),
}))

vi.mock('../../custom-hostnames/audited-state', () => ({
  persistCustomHostnameStateWithAudit: mocks.persistState,
  releaseCustomHostnameWithAudit: mocks.releaseState,
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
  dcvDelegationRecords: []
  validationRecords: []
  trafficCnameTarget: string
  verificationErrors: string[]
  requiresPasskeyReregistration: boolean
  activatedAt: Date | null
  lastPolledAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  const now = new Date('2026-07-28T00:00:00.000Z')
  return {
    id,
    tenantId: 'tenant_1',
    orgId: 'org_1',
    instanceId: 'inst_1',
    hostname: `${id}.customer.example`,
    cloudflareHostnameId: `cf_${id}`,
    status: 'pending',
    hostnameStatus: 'pending',
    sslStatus: 'pending_validation',
    ownershipVerificationType: 'txt',
    ownershipVerificationName: `_cf-custom-hostname.${id}.customer.example`,
    ownershipVerificationValue: `ownership-${id}`,
    ownershipExpiresAt: new Date('2026-07-29T00:00:00.000Z'),
    dcvDelegationRecords: [],
    validationRecords: [],
    trafficCnameTarget: 'customers.xid.test',
    verificationErrors: [],
    requiresPasskeyReregistration: true,
    activatedAt: null,
    lastPolledAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function details(
  current: Row,
  overrides: Partial<CloudflareCustomHostnameDetails> = {},
): CloudflareCustomHostnameDetails {
  return {
    id: current.cloudflareHostnameId!,
    hostname: current.hostname,
    status: 'pending',
    sslStatus: 'pending_validation',
    ownershipVerification: null,
    dcvDelegationRecords: [],
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
    trafficCnameTarget: vi.fn(),
    ...overrides,
  }
}

function optionsFor(
  customClient: CloudflareCustomHostnamesClientLike,
  now = new Date('2026-07-28T12:00:00.000Z'),
) {
  return {
    clientFactory: () => customClient,
    now,
  }
}

describe('custom hostname maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('polls every page and activates only a fully active remote hostname', async () => {
    const first = row('ch_1')
    const second = row('ch_2')
    const third = row('ch_3')
    mocks.selectLimit.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([third])
    const get = vi.fn(async (id: string) => {
      const current = [first, second, third].find(
        (candidate) => candidate.cloudflareHostnameId === id,
      )!
      return details(current, { status: 'active', sslStatus: 'active' })
    })

    await maintainCustomHostnames({ DB: {} } as Env, {
      ...optionsFor(client({ get })),
      pageSize: 2,
    })

    expect(get).toHaveBeenCalledTimes(3)
    expect(mocks.selectLimit).toHaveBeenCalledTimes(2)
    expect(mocks.selectLimit).toHaveBeenNthCalledWith(1, 2)
    expect(mocks.selectLimit).toHaveBeenNthCalledWith(2, 2)
    expect(mocks.persistState).toHaveBeenCalledTimes(3)
    expect(mocks.persistState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'custom_hostname.reconciled',
        patch: expect.objectContaining({
          status: 'active',
          hostnameStatus: 'active',
          sslStatus: 'active',
        }),
      }),
    )
  })

  it('deletes the remote hostname before releasing an expired ownership reservation', async () => {
    const expired = row('ch_expired', {
      ownershipExpiresAt: new Date('2026-07-27T00:00:00.000Z'),
    })
    mocks.selectLimit.mockResolvedValueOnce([expired])
    const calls: string[] = []
    const removeRemote = vi.fn(async () => {
      calls.push('remote')
    })
    const get = vi.fn(async () => details(expired))
    mocks.releaseState.mockImplementationOnce(async () => {
      calls.push('local')
    })

    await maintainCustomHostnames(
      { DB: {} } as Env,
      optionsFor(client({ delete: removeRemote, get })),
    )

    expect(calls).toEqual(['remote', 'local'])
    expect(removeRemote).toHaveBeenCalledWith('cf_ch_expired')
    expect(get).toHaveBeenCalledWith('cf_ch_expired')
    expect(mocks.releaseState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        row: expired,
        action: 'custom_hostname.ownership_expired',
      }),
    )
  })

  it('keeps the local reservation when remote deletion fails', async () => {
    const expired = row('ch_expired', {
      ownershipExpiresAt: new Date('2026-07-27T00:00:00.000Z'),
    })
    mocks.selectLimit.mockResolvedValueOnce([expired])
    const removeRemote = vi.fn(async () => {
      throw new Error('private upstream detail')
    })
    const get = vi.fn(async () => details(expired))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await maintainCustomHostnames(
      { DB: {} } as Env,
      optionsFor(client({ delete: removeRemote, get })),
    )

    expect(removeRemote).toHaveBeenCalledOnce()
    expect(mocks.releaseState).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.custom_hostname.poll_failed',
        severity: 'error',
        component: 'custom-hostname',
        operation: 'poll',
      }),
    )
    expect(JSON.stringify(error.mock.calls)).not.toContain('private upstream detail')
  })

  it('retries a failed remote deletion instead of polling it back to active', async () => {
    const pendingDeletion = row('ch_delete', { status: 'deletion_failed' })
    mocks.selectLimit.mockResolvedValueOnce([pendingDeletion])
    const removeRemote = vi.fn(async () => undefined)
    const get = vi.fn()
    const now = new Date('2026-07-28T12:00:00.000Z')

    await maintainCustomHostnames(
      { DB: {} } as Env,
      optionsFor(client({ delete: removeRemote, get }), now),
    )

    expect(removeRemote).toHaveBeenCalledWith('cf_ch_delete')
    expect(get).not.toHaveBeenCalled()
    expect(mocks.persistState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        row: pendingDeletion,
        action: 'custom_hostname.deleted',
        patch: {
          status: 'deleted',
          hostnameStatus: 'deleted',
          sslStatus: null,
          ownershipExpiresAt: null,
          deletedAt: now,
        },
      }),
    )
  })

  it('recovers an ambiguous create with no stored Cloudflare id by exact hostname', async () => {
    const ambiguous = row('ch_ambiguous', {
      cloudflareHostnameId: null,
      status: 'provisioning_failed',
    })
    mocks.selectLimit.mockResolvedValueOnce([ambiguous])
    const recovered = details(ambiguous, {
      id: 'cf_recovered',
      status: 'active',
      sslStatus: 'active',
    })
    const findByHostname = vi.fn(async () => recovered)

    await maintainCustomHostnames({ DB: {} } as Env, optionsFor(client({ findByHostname })))

    expect(findByHostname).toHaveBeenCalledWith(ambiguous.hostname)
    expect(mocks.persistState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'custom_hostname.reconciled',
        patch: expect.objectContaining({
          cloudflareHostnameId: 'cf_recovered',
          status: 'active',
        }),
      }),
    )
  })

  it('does not expire a row when the latest provider state has already verified ownership', async () => {
    const stale = row('ch_stale', {
      ownershipExpiresAt: new Date('2026-07-27T00:00:00.000Z'),
      hostnameStatus: 'pending',
    })
    mocks.selectLimit.mockResolvedValueOnce([stale])
    const get = vi.fn(async () =>
      details(stale, { status: 'active', sslStatus: 'pending_validation' }),
    )
    const removeRemote = vi.fn()

    await maintainCustomHostnames(
      { DB: {} } as Env,
      optionsFor(client({ get, delete: removeRemote })),
    )

    expect(removeRemote).not.toHaveBeenCalled()
    expect(mocks.releaseState).not.toHaveBeenCalled()
    expect(mocks.persistState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'custom_hostname.reconciled',
        patch: expect.objectContaining({
          hostnameStatus: 'active',
          ownershipExpiresAt: null,
        }),
      }),
    )
  })

  it('rejects a mismatched Cloudflare identity and continues with the next row', async () => {
    const mismatched = row('ch_mismatch')
    const valid = row('ch_valid')
    mocks.selectLimit.mockResolvedValueOnce([mismatched, valid])
    const get = vi.fn(async (id: string) =>
      id === mismatched.cloudflareHostnameId
        ? details(mismatched, { id: 'cf_attacker' })
        : details(valid),
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await maintainCustomHostnames({ DB: {} } as Env, optionsFor(client({ get })))

    expect(get).toHaveBeenCalledTimes(2)
    expect(mocks.persistState).toHaveBeenCalledTimes(1)
    expect(mocks.persistState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        patch: expect.objectContaining({
          cloudflareHostnameId: valid.cloudflareHostnameId,
        }),
      }),
    )
  })

  it('converges a locally active hostname when the stored provider object is already gone', async () => {
    const stale = row('ch_remote_missing', {
      status: 'active',
      hostnameStatus: 'active',
      sslStatus: 'active',
      ownershipExpiresAt: null,
    })
    mocks.selectLimit.mockResolvedValueOnce([stale])
    const get = vi.fn(async () => {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_http', { status: 404 })
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const now = new Date('2026-07-28T12:00:00.000Z')

    await maintainCustomHostnames({ DB: {} } as Env, optionsFor(client({ get }), now))

    expect(mocks.persistState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        row: stale,
        action: 'custom_hostname.remote_missing',
        patch: {
          status: 'deleted',
          hostnameStatus: 'deleted',
          sslStatus: null,
          ownershipExpiresAt: null,
          deletedAt: now,
        },
      }),
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('does not tombstone a hostname for a provider error other than not found', async () => {
    const current = row('ch_provider_unavailable', {
      status: 'active',
      hostnameStatus: 'active',
      sslStatus: 'active',
      ownershipExpiresAt: null,
    })
    mocks.selectLimit.mockResolvedValueOnce([current])
    const get = vi.fn(async () => {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_http', { status: 503 })
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await maintainCustomHostnames({ DB: {} } as Env, optionsFor(client({ get })))

    expect(mocks.persistState).not.toHaveBeenCalled()
    expect(mocks.releaseState).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.custom_hostname.poll_failed',
        severity: 'error',
      }),
    )
  })

  it('releases an expired ownership reservation when its provider object is already gone', async () => {
    const expired = row('ch_expired_missing', {
      ownershipExpiresAt: new Date('2026-07-27T00:00:00.000Z'),
    })
    mocks.selectLimit.mockResolvedValueOnce([expired])
    const get = vi.fn(async () => {
      throw new CloudflareCustomHostnameError('cloudflare_for_saas_http', { status: 404 })
    })

    await maintainCustomHostnames({ DB: {} } as Env, optionsFor(client({ get })))

    expect(mocks.releaseState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        row: expired,
        action: 'custom_hostname.ownership_expired',
      }),
    )
    expect(mocks.persistState).not.toHaveBeenCalled()
  })
})
