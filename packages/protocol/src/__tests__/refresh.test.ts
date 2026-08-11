import { describe, it, expect } from 'vitest'

import {
  detectReplay,
  decisionToResult,
  narrowScope,
  issueRefreshFamily,
  rotateRefresh,
  hashRefreshToken,
  generateRefreshToken,
  REFRESH_TOKEN_PREFIX,
  type RefreshTokenRecord,
} from '../refresh'

const NOW = 1_900_000_000

function baseRecord(over: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    id: 'rt_id_1',
    tenantId: 'tenant_test',
    tokenHash: 'hash1',
    familyId: 'fam_1',
    parentTokenId: null,
    userId: 'user_1',
    sessionId: null,
    clientId: 'client_1',
    scope: 'openid profile offline_access',
    jkt: null,
    activeOrgId: null,
    projectGrantId: null,
    resource: null,
    authorizationDetails: null,
    authTime: null,
    acr: null,
    amr: null,
    revokedAt: null,
    expiresAt: NOW + 1000,
    absoluteExpiresAt: NOW + 5000,
    createdAt: NOW - 100,
    ...over,
  }
}

describe('detectReplay', () => {
  it('returns ok for an active, unexpired, matching token', () => {
    const d = detectReplay({
      record: baseRecord(),
      clientId: 'client_1',
      now: NOW,
      presentedJkt: null,
    })
    expect(d.kind).toBe('ok')
  })

  it('flags replay and yields revokeFamily directive when token already revoked', () => {
    const d = detectReplay({
      record: baseRecord({ revokedAt: NOW - 10 }),
      clientId: 'client_1',
      now: NOW,
      presentedJkt: null,
    })
    expect(d.kind).toBe('replay')
    if (d.kind === 'replay') {
      expect(d.familyId).toBe('fam_1')
      expect(d.tenantId).toBe('tenant_test')
    }
    const r = decisionToResult(d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_grant')
  })

  it('flags expired when past idle expires_at', () => {
    const d = detectReplay({
      record: baseRecord({ expiresAt: NOW - 1 }),
      clientId: 'client_1',
      now: NOW,
      presentedJkt: null,
    })
    expect(d.kind).toBe('expired')
  })

  it('flags expired when past absolute_expires_at', () => {
    const d = detectReplay({
      record: baseRecord({ absoluteExpiresAt: NOW - 1 }),
      clientId: 'client_1',
      now: NOW,
      presentedJkt: null,
    })
    expect(d.kind).toBe('expired')
  })

  it('flags client_mismatch when client_id differs', () => {
    const d = detectReplay({
      record: baseRecord(),
      clientId: 'other_client',
      now: NOW,
      presentedJkt: null,
    })
    expect(d.kind).toBe('client_mismatch')
  })

  it('flags dpop_mismatch when bound jkt differs from presented', () => {
    const d = detectReplay({
      record: baseRecord({ jkt: 'jkt_a' }),
      clientId: 'client_1',
      now: NOW,
      presentedJkt: 'jkt_b',
    })
    expect(d.kind).toBe('dpop_mismatch')
  })

  it('accepts when bound jkt equals presented', () => {
    const d = detectReplay({
      record: baseRecord({ jkt: 'jkt_a' }),
      clientId: 'client_1',
      now: NOW,
      presentedJkt: 'jkt_a',
    })
    expect(d.kind).toBe('ok')
  })
})

describe('narrowScope', () => {
  it('keeps original scope when none requested', () => {
    const r = narrowScope('openid profile', null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('openid profile')
  })

  it('allows a subset', () => {
    const r = narrowScope('openid profile email', 'openid email')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('openid email')
  })

  it('rejects scope expansion with invalid_scope', () => {
    const r = narrowScope('openid', 'openid admin')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_scope')
  })
})

describe('issueRefreshFamily', () => {
  it('creates root token with null parent and matching hash', async () => {
    const issued = await issueRefreshFamily({
      tenantId: 'tenant_test',
      userId: 'user_1',
      clientId: 'client_1',
      scope: 'openid offline_access',
      jkt: null,
      now: NOW,
      newId: 'rt_new',
      familyId: 'fam_new',
    })
    expect(issued.token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true)
    expect(issued.record.parentTokenId).toBeNull()
    expect(issued.record.absoluteExpiresAt).toBeGreaterThan(issued.record.createdAt)
    const expectedHash = await hashRefreshToken(issued.token)
    expect(issued.tokenHash).toBe(expectedHash)
    expect(issued.record.tokenHash).toBe(expectedHash)
  })

  it('stores auth context on the root family token', async () => {
    const issued = await issueRefreshFamily({
      tenantId: 'tenant_test',
      userId: 'user_1',
      clientId: 'client_1',
      scope: 'openid offline_access',
      jkt: null,
      resource: ['https://api.example/v1'],
      authTime: NOW - 30,
      acr: 'urn:xid:aal2',
      amr: ['pwd', 'otp', 'mfa'],
      now: NOW,
      newId: 'rt_new',
      familyId: 'fam_new',
    })
    expect(issued.record.authTime).toBe(NOW - 30)
    expect(issued.record.acr).toBe('urn:xid:aal2')
    expect(issued.record.amr).toEqual(['pwd', 'otp', 'mfa'])
    expect(issued.record.resource).toEqual(['https://api.example/v1'])
  })

  it('stores authorization_details on the root family token', async () => {
    const authorizationDetails = [
      {
        type: 'resource_access' as const,
        locations: ['https://api.example/v1'],
        actions: ['read'],
      },
    ]
    const issued = await issueRefreshFamily({
      tenantId: 'tenant_test',
      userId: 'user_1',
      clientId: 'client_1',
      scope: 'openid offline_access read',
      jkt: null,
      resource: ['https://api.example/v1'],
      authorizationDetails,
      now: NOW,
      newId: 'rt_new',
      familyId: 'fam_new',
    })
    expect(issued.record.authorizationDetails).toEqual(authorizationDetails)
  })

  it('stores the hosted session id, defaulting to null', async () => {
    const withSession = await issueRefreshFamily({
      tenantId: 'tenant_test',
      userId: 'user_1',
      clientId: 'client_1',
      scope: 'openid offline_access',
      jkt: null,
      sessionId: 's_1',
      now: NOW,
      newId: 'rt_new',
      familyId: 'fam_new',
    })
    expect(withSession.record.sessionId).toBe('s_1')
    const withoutSession = await issueRefreshFamily({
      tenantId: 'tenant_test',
      userId: 'user_1',
      clientId: 'client_1',
      scope: 'openid offline_access',
      jkt: null,
      now: NOW,
      newId: 'rt_new',
      familyId: 'fam_new',
    })
    expect(withoutSession.record.sessionId).toBeNull()
  })
})

describe('rotateRefresh', () => {
  it('marks old revoked, links parent, inherits absolute, refreshes idle', async () => {
    const old = baseRecord({
      id: 'rt_old',
      absoluteExpiresAt: NOW + 9999,
      authTime: NOW - 50,
      acr: 'urn:xid:aal2',
      amr: ['pwd', 'otp', 'mfa'],
      resource: ['https://api.example/v1'],
      authorizationDetails: [
        {
          type: 'resource_access',
          locations: ['https://api.example/v1'],
          actions: ['read'],
        },
      ],
    })
    const { issued, revokedOld } = await rotateRefresh({
      old,
      scope: 'openid profile',
      now: NOW,
      newId: 'rt_next',
    })
    expect(revokedOld.revokedAt).toBe(NOW)
    expect(issued.record.parentTokenId).toBe('rt_old')
    expect(issued.record.familyId).toBe(old.familyId)
    expect(issued.record.absoluteExpiresAt).toBe(NOW + 9999) // 继承不顺延
    expect(issued.record.expiresAt).toBeGreaterThan(NOW) // idle 刷新
    expect(issued.record.authTime).toBe(NOW - 50)
    expect(issued.record.acr).toBe('urn:xid:aal2')
    expect(issued.record.amr).toEqual(['pwd', 'otp', 'mfa'])
    expect(issued.record.resource).toEqual(['https://api.example/v1'])
    expect(issued.record.authorizationDetails).toEqual([
      {
        type: 'resource_access',
        locations: ['https://api.example/v1'],
        actions: ['read'],
      },
    ])
  })

  it('inherits sessionId across rotation', async () => {
    const old = baseRecord({ id: 'rt_old', sessionId: 's_1' })

    const { issued } = await rotateRefresh({
      old,
      scope: 'openid profile',
      now: NOW,
      newId: 'rt_next',
    })

    expect(issued.record.sessionId).toBe('s_1')
  })

  it('produces a distinct token from the old one', async () => {
    const old = baseRecord()
    const a = generateRefreshToken()
    const b = generateRefreshToken()
    expect(a).not.toBe(b)
    const { issued } = await rotateRefresh({ old, scope: old.scope, now: NOW, newId: 'rt_x' })
    expect(issued.token).not.toBe(old.tokenHash)
  })
})
