import { describe, it, expect } from 'vitest'

import {
  resolveInstanceLogin,
  resolveTenantContext,
  resolveTenantContextByIssuer,
  resolveTenantContextBySessionHash,
  resolveTenantContextBySsoConnection,
} from '../tenant-context'
import { makeStatefulD1, seedMultiTenantInstance, type Store } from './stateful-d1'

function req(host: string, url = `https://${host}/`): Request {
  return new Request(url, { headers: { host } })
}

function envFor(store: Store): { DB: D1Database } {
  return { DB: makeStatefulD1(store) }
}

describe('resolveTenantContext', () => {
  it('returns 400 when Host header is missing', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveTenantContext(new Request('https://xid.test/'), envFor(store))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.httpStatus).toBe(400)
  })

  it('resolves tenant subdomain to org-scoped rpId', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveTenantContext(req('acme.xid.test'), envFor(store))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tenantId).toBe('org_acme')
      // buildContext 必须产出 instanceId:org 创建/子域冲突检查依赖该值,缺失会恒回退 tenantId。
      expect(result.value.instanceId).toBe('inst_1')
      expect(result.value.rpId).toBe('acme.xid.test')
      expect(result.value.issuer).toBe('https://xid.test')
    }
  })

  it('maps instance root host to instance entry context', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveTenantContext(req('xid.test'), envFor(store))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.resolution?.kind).toBe('instance_entry')
      expect(result.value.rpId).toBe('xid.test')
    }
  })

  it('returns 404 for unknown tenant subdomain', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveTenantContext(req('unknown.xid.test'), envFor(store))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('tenant_not_found')
  })

  it('returns 403 when org is suspended', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const org = store['organizations']?.find((row) => row['slug'] === 'acme')
    if (org) org['status'] = 'suspended'
    const result = await resolveTenantContext(req('acme.xid.test'), envFor(store))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('tenant_suspended')
  })
})

describe('resolveInstanceLogin', () => {
  it('returns ambiguous when email exists in multiple orgs', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const now = Date.now()
    store['users'] = [
      {
        id: 'u1',
        tenant_id: 'org_default',
        status: 'active',
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'u2',
        tenant_id: 'org_acme',
        status: 'active',
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    ]
    store['user_emails'] = [
      {
        tenant_id: 'org_default',
        user_id: 'u1',
        email: 'dup@example.com',
        created_at: now,
        updated_at: now,
      },
      {
        tenant_id: 'org_acme',
        user_id: 'u2',
        email: 'dup@example.com',
        created_at: now,
        updated_at: now,
      },
    ]
    const result = await resolveInstanceLogin(req('xid.test'), envFor(store), {
      kind: 'email',
      value: 'dup@example.com',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('ambiguous')
      if (result.value.status === 'ambiguous') expect(result.value.matches).toHaveLength(2)
    }
  })

  it('returns new_user for unknown email on instance entry', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveInstanceLogin(req('xid.test'), envFor(store), {
      kind: 'email',
      value: 'new-user@example.com',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('new_user')
      if (result.value.status === 'new_user')
        expect(result.value.tenant.tenantId).toBe('org_default')
    }
  })

  it('maps verified organization domain to tenant for new users', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const now = Date.now()
    store['organization_domains'] = [
      {
        tenant_id: 'org_acme',
        domain: 'acme.com',
        verification_status: 'verified',
        status: 'active',
        deleted_at: null,
        is_wildcard: false,
        created_at: now,
        updated_at: now,
      },
    ]
    const result = await resolveInstanceLogin(req('xid.test'), envFor(store), {
      kind: 'email',
      value: 'hire@acme.com',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('new_user')
      if (result.value.status === 'new_user') expect(result.value.tenant.tenantId).toBe('org_acme')
    }
  })
})

describe('resolveTenantContextByIssuer', () => {
  it('requires tenant hint on instance issuer', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveTenantContextByIssuer(
      req('xid.test'),
      envFor(store),
      'https://xid.test',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('tenant_not_found')
  })

  it('resolves tenant when hint is provided', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveTenantContextByIssuer(
      req('xid.test'),
      envFor(store),
      'https://xid.test',
      { tenantId: 'org_acme' },
    )
    expect(result.ok).toBe(true)
    if (result.ok && result.value.status === 'resolved') {
      expect(result.value.tenant.tenantId).toBe('org_acme')
    }
  })
})

describe('resolveTenantContextBySessionHash', () => {
  it('resolves tenant from active session refresh hash', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const expires = new Date(Date.now() + 60_000)
    store['sessions'] = [
      {
        tenant_id: 'org_acme',
        refresh_token_hash: 'hash_session_1',
        status: 'active',
        expires_at: expires,
      },
    ]
    const result = await resolveTenantContextBySessionHash(
      req('xid.test'),
      envFor(store),
      'hash_session_1',
    )
    expect(result.ok).toBe(true)
    if (result.ok && result.value.status === 'resolved') {
      expect(result.value.tenant.tenantId).toBe('org_acme')
    }
  })

  it('returns 404 when session hash is unknown', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    const result = await resolveTenantContextBySessionHash(
      req('xid.test'),
      envFor(store),
      'missing_hash',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('tenant_not_found')
  })

  it('resolves pending MFA setup session for an explicitly allowed session flow', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    store['sessions'] = [
      {
        tenant_id: 'org_acme',
        refresh_token_hash: 'hash_setup_1',
        status: 'pending_mfa_setup',
        expires_at: new Date(Date.now() + 60_000),
      },
    ]
    const result = await resolveTenantContextBySessionHash(
      req('xid.test'),
      envFor(store),
      'hash_setup_1',
    )
    expect(result.ok).toBe(true)
    if (result.ok && result.value.status === 'resolved') {
      expect(result.value.session?.status).toBe('pending_mfa_setup')
    }
  })
})

describe('resolveTenantContextBySsoConnection', () => {
  it('maps active SSO connection to tenant', async () => {
    const store: Store = {}
    seedMultiTenantInstance(store)
    store['sso_connections'] = [{ id: 'conn_1', tenant_id: 'org_acme', status: 'active' }]
    const result = await resolveTenantContextBySsoConnection(
      req('xid.test'),
      envFor(store),
      'conn_1',
    )
    expect(result.ok).toBe(true)
    if (result.ok && result.value.status === 'resolved') {
      expect(result.value.tenant.tenantId).toBe('org_acme')
    }
  })
})
