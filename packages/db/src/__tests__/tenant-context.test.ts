import { describe, it, expect } from 'vitest'

import { schema } from '../index'
import { buildPolicy, instanceIssuerFor } from '../tenant-context'

type InstanceRow = typeof schema.instances.$inferSelect
type OrgRow = typeof schema.organizations.$inferSelect
type OrgPolicyRow = typeof schema.orgPolicies.$inferSelect

function instanceRow(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'inst_1',
    name: 'Test Instance',
    primaryDomain: 'xid.test',
    mode: 'multi_tenant',
    defaultLocale: 'en',
    dataResidency: 'us',
    mfaPolicy: 'optional',
    passwordPolicy: {},
    sessionPolicy: {},
    tokenPolicy: null,
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

function orgRow(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    id: 'org_1',
    tenantId: 'org_1',
    instanceId: 'inst_1',
    parentOrgId: null,
    slug: 'default',
    name: 'Default Org',
    logoUrl: null,
    publicMetadata: {},
    privateMetadata: {},
    seatLimit: null,
    seatUsed: 0,
    enrollmentMode: 'invite_required',
    allowOrgSelfService: true,
    status: 'active',
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

function orgPolicyRow(overrides: Partial<OrgPolicyRow> = {}): OrgPolicyRow {
  return {
    id: 'op_1',
    tenantId: 'org_1',
    orgId: 'org_1',
    mfaPolicy: null,
    mfaAllowedMethods: null,
    passwordPolicy: null,
    tokenPolicy: null,
    sessionIdleTimeoutMin: null,
    sessionAbsoluteTimeoutDays: null,
    forceSso: false,
    allowPasswordLogin: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe('instanceIssuerFor', () => {
  it('builds https issuer from primary domain', () => {
    expect(instanceIssuerFor({ primaryDomain: 'xid.dev' })).toBe('https://xid.dev')
    expect(instanceIssuerFor({ primaryDomain: 'auth.customer.com' })).toBe(
      'https://auth.customer.com',
    )
  })
})

describe('buildPolicy session chain', () => {
  it('org columns override instance session_policy per field', () => {
    const instance = instanceRow({
      sessionPolicy: { idle_timeout_min: 60, absolute_timeout_days: 10 },
    })
    const policy = orgPolicyRow({ sessionIdleTimeoutMin: 120 })

    const result = buildPolicy(instance, orgRow(), policy)

    expect(result.session).toEqual({ idleTimeoutMin: 120, absoluteTimeoutDays: 10 })
  })

  it('falls back to instance session_policy when org columns are unset', () => {
    const instance = instanceRow({
      sessionPolicy: { idle_timeout_min: 45, absolute_timeout_days: 5, remember_me_default: true },
    })

    const result = buildPolicy(instance, orgRow(), orgPolicyRow())

    expect(result.session).toEqual({
      idleTimeoutMin: 45,
      absoluteTimeoutDays: 5,
      rememberMeDefault: true,
    })
  })

  it('falls back to built-in defaults when nothing is configured', () => {
    const result = buildPolicy(instanceRow(), orgRow())

    expect(result.session).toEqual({ idleTimeoutMin: 4320, absoluteTimeoutDays: 30 })
  })

  it('maps camelCase keys in instance session_policy JSON', () => {
    const instance = instanceRow({ sessionPolicy: { idleTimeoutMin: 100 } })

    const result = buildPolicy(instance, orgRow())

    expect(result.session).toEqual({ idleTimeoutMin: 100, absoluteTimeoutDays: 30 })
  })

  it('clamps org column values to bounds', () => {
    const policy = orgPolicyRow({ sessionIdleTimeoutMin: 1 })

    const result = buildPolicy(instanceRow(), orgRow(), policy)

    expect(result.session?.idleTimeoutMin).toBe(5)
  })
})

describe('buildPolicy token chain', () => {
  it('org token_policy overrides instance token_policy', () => {
    const instance = instanceRow({ tokenPolicy: { access_token_ttl_sec: 7200 } })
    const policy = orgPolicyRow({ tokenPolicy: { access_token_ttl_sec: 120 } })

    const result = buildPolicy(instance, orgRow(), policy)

    expect(result.token).toEqual({
      accessTokenTtlSec: 120,
      sessionTokenTtlSec: 60,
      refreshIdleTimeoutDays: 30,
      refreshAbsoluteTimeoutDays: 7,
    })
  })

  it('falls back to instance token_policy when org token_policy is unset', () => {
    const instance = instanceRow({
      tokenPolicy: {
        access_token_ttl_sec: 1800,
        session_token_ttl_sec: 90,
        refresh_idle_timeout_days: 14,
        refresh_absolute_timeout_days: 3,
      },
    })

    const result = buildPolicy(instance, orgRow())

    expect(result.token).toEqual({
      accessTokenTtlSec: 1800,
      sessionTokenTtlSec: 90,
      refreshIdleTimeoutDays: 14,
      refreshAbsoluteTimeoutDays: 3,
    })
  })

  it('falls back to built-in defaults when nothing is configured', () => {
    const result = buildPolicy(instanceRow(), orgRow())

    expect(result.token).toEqual({
      accessTokenTtlSec: 3600,
      sessionTokenTtlSec: 60,
      refreshIdleTimeoutDays: 30,
      refreshAbsoluteTimeoutDays: 7,
    })
  })

  it('normalizes out-of-bounds and non-number fields', () => {
    const policy = orgPolicyRow({
      tokenPolicy: { access_token_ttl_sec: 10, session_token_ttl_sec: '90' },
    })

    const result = buildPolicy(instanceRow(), orgRow(), policy)

    expect(result.token?.accessTokenTtlSec).toBe(60)
    expect(result.token?.sessionTokenTtlSec).toBe(60)
  })
})
