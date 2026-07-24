// profile-fields 单元测试:可见字段、必填校验、identity 优先与 completion 状态。
import { describe, expect, it } from 'vitest'
import type { HostedAuthPolicy, TenantContext } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { HostedAuthPolicyError } from '../hosted-policy'
import {
  normalizeProfileFields,
  profileFieldRequired,
  visibleProfileFieldKeys,
} from '../profile-fields'

function makeTenant(profileFields: HostedAuthPolicy['profileFields']): TenantContext {
  return {
    tenantId: 'tenant_test',
    issuer: 'https://test.xid.dev',
    rpId: 'test.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {
      hostedAuth: {
        ...DEFAULT_HOSTED_AUTH_POLICY,
        profileFields,
      },
    },
  }
}

describe('profileFieldRequired', () => {
  it('returns true only when field mode is required', () => {
    const tenant = makeTenant({
      email: 'required',
      username: 'optional',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    })
    expect(profileFieldRequired(tenant, 'email')).toBe(true)
    expect(profileFieldRequired(tenant, 'username')).toBe(false)
    expect(profileFieldRequired(tenant, 'phone')).toBe(false)
  })
})

describe('visibleProfileFieldKeys', () => {
  it('omits hidden fields from visible keys', () => {
    expect(
      visibleProfileFieldKeys({
        ...DEFAULT_HOSTED_AUTH_POLICY,
        profileFields: {
          email: 'required',
          username: 'optional',
          phone: 'hidden',
          name: 'hidden',
          givenName: 'optional',
          familyName: 'hidden',
        },
      }),
    ).toEqual(['email', 'username', 'givenName'])
  })
})

describe('normalizeProfileFields', () => {
  it('lowercases email and username from input', () => {
    const tenant = makeTenant({
      email: 'optional',
      username: 'optional',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    })
    const result = normalizeProfileFields(tenant, {
      email: ' User@Example.COM ',
      username: ' MyUser ',
    })
    expect(result.email).toBe('user@example.com')
    expect(result.username).toBe('myuser')
    expect(result.profileCompletionStatus).toBe('complete')
  })

  it('prefers identity values over input and skips hidden fields', () => {
    const tenant = makeTenant({
      email: 'optional',
      username: 'optional',
      phone: 'hidden',
      name: 'optional',
      givenName: 'hidden',
      familyName: 'hidden',
    })
    const result = normalizeProfileFields(
      tenant,
      { email: 'input@example.com', name: 'Input Name' },
      { email: 'Identity@Example.COM', username: 'identity_user' },
    )
    expect(result.email).toBe('identity@example.com')
    expect(result.username).toBe('identity_user')
    expect(result.displayName).toBe('Input Name')
    expect(result.phone).toBeNull()
  })

  it('builds displayName from given and family names when name hidden', () => {
    const tenant = makeTenant({
      email: 'required',
      username: 'hidden',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'optional',
      familyName: 'optional',
    })
    const result = normalizeProfileFields(tenant, {
      email: 'user@example.com',
      givenName: 'Ada',
      familyName: 'Lovelace',
    })
    expect(result.displayName).toBe('Ada Lovelace')
    expect(result.profileCompletionStatus).toBe('complete')
  })

  it('throws profile_field_required when required field missing', () => {
    const tenant = makeTenant({
      email: 'required',
      username: 'required',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    })
    expect(() => normalizeProfileFields(tenant, { email: 'user@example.com' })).toThrow(
      HostedAuthPolicyError,
    )
    try {
      normalizeProfileFields(tenant, { email: 'user@example.com' })
    } catch (err) {
      expect((err as HostedAuthPolicyError).policyReason).toBe('profile_field_required')
    }
  })

  it('marks incomplete when optional visible field is empty', () => {
    const tenant = makeTenant({
      email: 'required',
      username: 'optional',
      phone: 'hidden',
      name: 'hidden',
      givenName: 'hidden',
      familyName: 'hidden',
    })
    const result = normalizeProfileFields(tenant, { email: 'user@example.com' })
    expect(result.profileCompletionStatus).toBe('incomplete')
  })
})
