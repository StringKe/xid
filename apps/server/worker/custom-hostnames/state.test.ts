import { describe, expect, it } from 'vitest'
import type { CloudflareCustomHostnameDetails } from '../lib/cloudflare-custom-hostnames'
import { customHostnameLifecycleStatus, customHostnameStatePatch } from './state'

function details(
  overrides: Partial<CloudflareCustomHostnameDetails> = {},
): CloudflareCustomHostnameDetails {
  return {
    id: 'cf_hostname_1',
    hostname: 'login.customer.example',
    status: 'pending',
    sslStatus: 'pending_validation',
    ownershipVerification: null,
    dcvDelegationRecords: [],
    validationRecords: [],
    verificationErrors: [],
    ...overrides,
  }
}

const existing = {
  activatedAt: null,
  ownershipExpiresAt: null,
  ownershipVerificationType: null,
  ownershipVerificationName: null,
  ownershipVerificationValue: null,
}

describe('custom hostname lifecycle state', () => {
  it.each([
    [{ status: 'active', sslStatus: 'pending_validation' }, 'pending'],
    [{ status: 'pending', sslStatus: 'active' }, 'pending'],
    [{ status: 'active', sslStatus: 'active' }, 'active'],
  ] as const)('maps %j to %s', (input, expected) => {
    expect(customHostnameLifecycleStatus(input)).toBe(expected)
  })

  it('binds ownership instructions for 24 hours while ownership is pending', () => {
    const now = new Date('2026-07-28T00:00:00.000Z')
    const patch = customHostnameStatePatch(
      details({
        ownershipVerification: {
          type: 'txt',
          name: '_cf-custom-hostname.login.customer.example',
          value: 'ownership-value',
        },
      }),
      existing,
      now,
    )

    expect(patch).toMatchObject({
      status: 'pending',
      hostnameStatus: 'pending',
      sslStatus: 'pending_validation',
      ownershipVerificationType: 'txt',
      ownershipVerificationName: '_cf-custom-hostname.login.customer.example',
      ownershipVerificationValue: 'ownership-value',
      lastPolledAt: now,
    })
    expect(patch.ownershipExpiresAt).toEqual(new Date('2026-07-29T00:00:00.000Z'))
  })

  it('preserves ownership instructions and their original expiry when polling omits them', () => {
    const expiry = new Date('2026-07-29T00:00:00.000Z')
    const patch = customHostnameStatePatch(
      details(),
      {
        ...existing,
        ownershipExpiresAt: expiry,
        ownershipVerificationType: 'txt',
        ownershipVerificationName: '_cf-custom-hostname.login.customer.example',
        ownershipVerificationValue: 'ownership-value',
      },
      new Date('2026-07-28T12:00:00.000Z'),
    )

    expect(patch).toMatchObject({
      ownershipExpiresAt: expiry,
      ownershipVerificationType: 'txt',
      ownershipVerificationName: '_cf-custom-hostname.login.customer.example',
      ownershipVerificationValue: 'ownership-value',
    })
  })

  it('activates only after hostname ownership and SSL are active', () => {
    const now = new Date('2026-07-28T12:00:00.000Z')
    const patch = customHostnameStatePatch(
      details({ status: 'active', sslStatus: 'active' }),
      existing,
      now,
    )

    expect(patch).toMatchObject({
      status: 'active',
      hostnameStatus: 'active',
      sslStatus: 'active',
      ownershipExpiresAt: null,
      activatedAt: now,
      lastPolledAt: now,
    })
  })

  it('does not replace the first activation timestamp on later polls', () => {
    const activatedAt = new Date('2026-07-28T12:00:00.000Z')
    const patch = customHostnameStatePatch(
      details({ status: 'active', sslStatus: 'active' }),
      { ...existing, activatedAt },
      new Date('2026-07-28T13:00:00.000Z'),
    )

    expect(patch.activatedAt).toBe(activatedAt)
  })
})
