// oidc-id-token.ts:OIDC Core 3.1.3.7 的 exp/iat/azp 校验、未知 kid 刷新重验、attributeMapping 映射。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifyKeySet } from '@xid-kit/crypto'

const verifyJwtMock = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return { ...actual, verifyJwt: verifyJwtMock }
})

import { isAppError } from '../../lib/errors'
import { checkIdTokenClaims, claimsToAssertion, verifyIdToken } from '../oidc-id-token'

const NOW = Math.floor(Date.now() / 1000)
const VALID = { sub: 'u1', nonce: 'n1', iat: NOW, exp: NOW + 600, aud: 'client-1' }
const OLD_KEYS: VerifyKeySet = { keys: [] }
const NEW_KEYS: VerifyKeySet = { keys: [] }

function verifyParams(loadKeys: (force: boolean) => Promise<VerifyKeySet | null>) {
  return {
    idToken: 'h.p.s',
    loadKeys,
    expectedIssuer: 'https://idp.example.com',
    expectedAudience: 'client-1',
    expectedNonce: 'n1',
  }
}

function expectInvalid(fn: () => unknown, reason: string): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(isAppError(caught) && caught.code === 'signature_invalid').toBe(true)
  expect(isAppError(caught) ? caught.longMessage : '').toContain(reason)
}

describe('checkIdTokenClaims', () => {
  it('accepts a single audience token with exp and iat', () => {
    expect(() => checkIdTokenClaims(VALID, 'client-1')).not.toThrow()
  })

  it('rejects a token without exp', () => {
    const { exp: _exp, ...claims } = VALID

    expectInvalid(() => checkIdTokenClaims(claims, 'client-1'), 'exp_missing')
  })

  it('rejects a token without iat', () => {
    const { iat: _iat, ...claims } = VALID

    expectInvalid(() => checkIdTokenClaims(claims, 'client-1'), 'iat_missing')
  })

  it('rejects multiple audiences without azp', () => {
    expectInvalid(
      () => checkIdTokenClaims({ ...VALID, aud: ['client-1', 'other'] }, 'client-1'),
      'azp_missing',
    )
  })

  it('rejects an azp that is not this client', () => {
    expectInvalid(
      () => checkIdTokenClaims({ ...VALID, aud: ['client-1', 'other'], azp: 'other' }, 'client-1'),
      'azp_mismatch',
    )
  })

  it('accepts multiple audiences when azp is this client', () => {
    expect(() =>
      checkIdTokenClaims({ ...VALID, aud: ['client-1', 'other'], azp: 'client-1' }, 'client-1'),
    ).not.toThrow()
  })
})

describe('verifyIdToken unknown kid refresh', () => {
  beforeEach(() => {
    verifyJwtMock.mockReset()
  })

  it('refreshes the JWKS once on unknown_kid and accepts the token signed by the new key', async () => {
    verifyJwtMock.mockImplementation(async (_token: string, keys: VerifyKeySet) =>
      keys === NEW_KEYS
        ? { ok: true, value: { header: {}, payload: VALID } }
        : { ok: false, error: { reason: 'unknown_kid' } },
    )
    const loadKeys = vi.fn(async (force: boolean) => (force ? NEW_KEYS : OLD_KEYS))

    const claims = await verifyIdToken(verifyParams(loadKeys))

    expect(claims['sub']).toBe('u1')
    expect(loadKeys.mock.calls).toEqual([[false], [true]])
  })

  it('fails when the refresh is throttled', async () => {
    verifyJwtMock.mockResolvedValue({ ok: false, error: { reason: 'unknown_kid' } })
    const loadKeys = vi.fn(async (force: boolean) => (force ? null : OLD_KEYS))

    await expect(verifyIdToken(verifyParams(loadKeys))).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.code === 'signature_invalid',
    )
  })

  it('does not refresh on a bad signature', async () => {
    verifyJwtMock.mockResolvedValue({ ok: false, error: { reason: 'bad_signature' } })
    const loadKeys = vi.fn(async () => OLD_KEYS)

    await expect(verifyIdToken(verifyParams(loadKeys))).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.code === 'signature_invalid',
    )
    expect(loadKeys).toHaveBeenCalledTimes(1)
  })

  it('rejects a verified token that lacks exp', async () => {
    const { exp: _exp, ...payload } = VALID
    verifyJwtMock.mockResolvedValue({ ok: true, value: { header: {}, payload } })

    await expect(verifyIdToken(verifyParams(async () => OLD_KEYS))).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.code === 'signature_invalid',
    )
  })
})

describe('claimsToAssertion attributeMapping', () => {
  it('reads mapped claims and uses sub as idpId when no idpId claim is configured', () => {
    const assertion = claimsToAssertion({
      claims: {
        sub: 'stable-sub',
        upn: 'alice@corp.example',
        first: 'Alice',
        roles: ['Engineering'],
        email: 'other@corp.example',
        email_verified: true,
      },
      connectionId: 'conn-1',
      orgId: 'org-1',
      attributeMapping: { email: 'upn', firstName: 'first', groups: 'roles' },
    })

    expect(assertion).toMatchObject({
      idpId: 'stable-sub',
      email: 'alice@corp.example',
      emailVerified: false,
      firstName: 'Alice',
      groups: ['Engineering'],
    })
    expect(assertion.legacyIdpId).toBeUndefined()
  })

  it('uses the configured idpId claim as the key and carries sub as the legacy binding', () => {
    const assertion = claimsToAssertion({
      claims: { sub: 'pairwise-sub', oid: '6f1c-object-id' },
      connectionId: 'conn-1',
      orgId: 'org-1',
      attributeMapping: { idpId: 'oid' },
    })

    expect(assertion.idpId).toBe('6f1c-object-id')
    expect(assertion.legacyIdpId).toBe('pairwise-sub')
  })

  it('accepts a numeric idpId claim as its decimal string', () => {
    const assertion = claimsToAssertion({
      claims: { sub: 's', employee_number: 1042 },
      connectionId: 'conn-1',
      orgId: 'org-1',
      attributeMapping: { idpId: 'employee_number' },
    })

    expect(assertion.idpId).toBe('1042')
  })

  it('omits legacyIdpId when the configured claim equals sub', () => {
    const assertion = claimsToAssertion({
      claims: { sub: 'same', oid: 'same' },
      connectionId: 'conn-1',
      orgId: 'org-1',
      attributeMapping: { idpId: 'oid' },
    })

    expect(assertion.idpId).toBe('same')
    expect(assertion.legacyIdpId).toBeUndefined()
  })

  it.each([
    ['absent', {}],
    ['empty', { oid: '  ' }],
    ['non-scalar', { oid: ['a'] }],
  ])(
    'rejects a token whose configured idpId claim is %s instead of falling back to sub',
    (_label, extra) => {
      let caught: unknown

      try {
        claimsToAssertion({
          claims: { sub: 's', ...extra },
          connectionId: 'conn-1',
          orgId: 'org-1',
          attributeMapping: { idpId: 'oid' },
        })
      } catch (err) {
        caught = err
      }

      expect(isAppError(caught) && caught.code === 'malformed_request').toBe(true)
      expect(isAppError(caught) ? caught.longMessage : '').toBe('oidc:idp_id_claim_missing')
    },
  )

  it('falls back to standard claims when the mapped claim is absent', () => {
    const assertion = claimsToAssertion({
      claims: {
        sub: 's',
        email: 'bob@corp.example',
        email_verified: true,
        given_name: 'Bob',
        family_name: 'Lee',
        groups: ['Ops'],
      },
      connectionId: 'conn-1',
      orgId: 'org-1',
      attributeMapping: {
        email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      },
    })

    expect(assertion).toMatchObject({
      email: 'bob@corp.example',
      emailVerified: true,
      firstName: 'Bob',
      lastName: 'Lee',
      groups: ['Ops'],
    })
  })
})
