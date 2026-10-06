import { describe, expect, it } from 'vitest'
import { isAppError } from '../../lib/errors'
import {
  encryptScimTargetToken,
  normalizeScimTargetBaseUrl,
  requireScimTargetToken,
  scimTargetHasToken,
  scimTargetTokenSecretName,
} from '../target-credentials'

const TARGET_ID = 'st_legacy-1'
const LEGACY_SECRET_NAME = 'SCIM_TARGET_TOKEN_st_legacy_1'
const NO_COLUMNS = { id: TARGET_ID, tokenIv: null, tokenCiphertext: null, tokenTag: null }

function testEnv(extra: Record<string, unknown> = {}): Env {
  const kek = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  return { KEK: kek, ...extra } as unknown as Env
}

describe('outbound SCIM target credentials', () => {
  it('stores only an envelope-encrypted token and decrypts it with the same KEK', async () => {
    const env = testEnv()

    const columns = await encryptScimTargetToken(env, 'downstream-token')
    const target = { id: TARGET_ID, ...columns }

    expect(JSON.stringify(columns)).not.toContain('downstream-token')
    expect(scimTargetHasToken(env, target)).toBe(true)
    expect(await requireScimTargetToken(env, target)).toBe('downstream-token')
  })

  it('rejects decryption under a different KEK', async () => {
    const columns = await encryptScimTargetToken(testEnv(), 'downstream-token')

    await expect(
      requireScimTargetToken(testEnv(), { id: TARGET_ID, ...columns }),
    ).rejects.toThrowError()
  })

  it('derives the legacy Workers Secret name from the target id only', () => {
    expect(scimTargetTokenSecretName(TARGET_ID)).toBe(LEGACY_SECRET_NAME)
    expect(() => scimTargetTokenSecretName('../KEK')).toThrowError()
  })

  it('falls back to the legacy Workers Secret when no encrypted token is stored', async () => {
    const env = testEnv({ [LEGACY_SECRET_NAME]: 'legacy-token' })

    expect(scimTargetHasToken(env, NO_COLUMNS)).toBe(true)
    expect(await requireScimTargetToken(env, NO_COLUMNS)).toBe('legacy-token')
  })

  it('prefers the encrypted token over a legacy Workers Secret', async () => {
    const env = testEnv({ [LEGACY_SECRET_NAME]: 'legacy-token' })
    const columns = await encryptScimTargetToken(env, 'rotated-token')

    expect(await requireScimTargetToken(env, { id: TARGET_ID, ...columns })).toBe('rotated-token')
  })

  it('ignores a blank legacy Workers Secret', () => {
    expect(scimTargetHasToken(testEnv({ [LEGACY_SECRET_NAME]: '  ' }), NO_COLUMNS)).toBe(false)
  })

  it('reports a missing token as validation_failed on the token field', async () => {
    const env = testEnv()

    expect(scimTargetHasToken(env, NO_COLUMNS)).toBe(false)
    await expect(requireScimTargetToken(env, NO_COLUMNS)).rejects.toSatisfy(
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
