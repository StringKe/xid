import { describe, expect, it } from 'vitest'
import { isAppError } from '../../lib/errors'
import {
  encryptScimTargetToken,
  normalizeScimTargetBaseUrl,
  requireScimTargetToken,
  scimTargetHasToken,
} from '../target-credentials'

function testEnv(): Env {
  const kek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  return { KEK: kek } as unknown as Env
}

describe('outbound SCIM target credentials', () => {
  it('stores only an envelope-encrypted token and decrypts it with the same KEK', async () => {
    const env = testEnv()

    const columns = await encryptScimTargetToken(env, 'downstream-token')

    expect(JSON.stringify(columns)).not.toContain('downstream-token')
    expect(scimTargetHasToken(columns)).toBe(true)
    expect(await requireScimTargetToken(env, columns)).toBe('downstream-token')
  })

  it('rejects decryption under a different KEK', async () => {
    const columns = await encryptScimTargetToken(testEnv(), 'downstream-token')

    await expect(requireScimTargetToken(testEnv(), columns)).rejects.toThrowError()
  })

  it('reports a missing token as validation_failed on the token field', async () => {
    const columns = { tokenIv: null, tokenCiphertext: null, tokenTag: null }

    expect(scimTargetHasToken(columns)).toBe(false)
    await expect(requireScimTargetToken(testEnv(), columns)).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) &&
        error.code === 'validation_failed' &&
        error.meta?.paramName === 'token',
    )
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
