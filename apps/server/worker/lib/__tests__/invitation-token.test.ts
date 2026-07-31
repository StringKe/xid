import { describe, expect, it } from 'vitest'
import { createTenantBoundInvitationToken, invitationTenantIdFromToken } from '../invitation-token'

describe('tenant-bound invitation token', () => {
  it('round-trips the Tenant locator without exposing it as plaintext', () => {
    const token = createTenantBoundInvitationToken('tenant_acme')
    expect(token).not.toContain('tenant_acme')
    expect(invitationTenantIdFromToken(token)).toBe('tenant_acme')
  })

  it('rejects legacy, malformed, and empty locator forms', () => {
    expect(invitationTenantIdFromToken('legacy-random-token')).toBeNull()
    expect(invitationTenantIdFromToken('xid_inv_v1.bad.short')).toBeNull()
    expect(invitationTenantIdFromToken('')).toBeNull()
  })

  it('mints independent opaque secrets for the same Tenant', () => {
    const first = createTenantBoundInvitationToken('tenant_acme')
    const second = createTenantBoundInvitationToken('tenant_acme')
    expect(first).not.toBe(second)
    expect(invitationTenantIdFromToken(first)).toBe('tenant_acme')
    expect(invitationTenantIdFromToken(second)).toBe('tenant_acme')
  })
})
