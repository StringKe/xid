import { describe, expect, it } from 'vitest'
import {
  normalizeScimTargetBaseUrl,
  requireScimTargetToken,
  scimTargetHasToken,
  scimTargetTokenSecretName,
} from '../target-credentials'

describe('outbound SCIM target credentials', () => {
  it('derives one reserved secret name from the server-generated target id', () => {
    expect(scimTargetTokenSecretName('target-a_1')).toBe('SCIM_TARGET_TOKEN_target_a_1')
  })

  it('never resolves a tenant-selected account-level binding', () => {
    const env = {
      KEK: 'account-kek',
      PEPPER: 'account-pepper',
      SCIM_TARGET_TOKEN_target_1: 'downstream-token',
    } as unknown as Env

    expect(requireScimTargetToken(env, 'target-1')).toBe('downstream-token')
    expect(scimTargetHasToken(env, 'target-1')).toBe(true)
    expect(() => requireScimTargetToken(env, 'KEK/../../')).toThrowError()
  })

  it.each([
    'http://scim.example.test/v2',
    'https://127.0.0.1/scim',
    'https://user:password@scim.example.test/v2',
    'https://scim.example.test/v2?token=secret',
    'https://scim.example.test/v2#fragment',
  ])('rejects unsafe downstream base URL %s', (value) => {
    expect(() => normalizeScimTargetBaseUrl(value)).toThrowError()
  })

  it('rejects loopback HTTP without an explicit development or test environment', () => {
    expect(() => normalizeScimTargetBaseUrl('http://127.0.0.1:8787/scim/v2')).toThrowError()
  })

  it.each(['development', 'test'])(
    'allows loopback HTTP only for the %s runtime environment',
    (environment) => {
      expect(normalizeScimTargetBaseUrl('http://127.0.0.1:8787/scim/v2///', { environment })).toBe(
        'http://127.0.0.1:8787/scim/v2',
      )
    },
  )

  it.each([
    ['production', 'http://127.0.0.1:8787/scim/v2'],
    ['development', 'http://scim.example.test/v2'],
    ['test', 'http://10.0.0.1/scim/v2'],
  ])('rejects non-eligible runtime URL in %s: %s', (environment, value) => {
    expect(() => normalizeScimTargetBaseUrl(value, { environment })).toThrowError()
  })

  it('normalizes a public HTTPS base URL without trailing slashes', () => {
    expect(normalizeScimTargetBaseUrl('https://scim.example.test/scim/v2///')).toBe(
      'https://scim.example.test/scim/v2',
    )
  })
})
