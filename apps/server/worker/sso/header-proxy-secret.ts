// Header SSO trusts identity headers only when the reverse proxy presents the per-connection
// shared secret. Only a SHA-256 digest of that secret is stored.

import { sha256Hex } from '@xid-kit/crypto'
import { AppError } from '../lib/errors'
import { type LegacyConfig, readLegacyConfigFromMapping } from './legacy-config'

const TRUSTED_PROXY_DIGEST_PREFIX = 'sha256:v1:'
const MIN_TRUSTED_PROXY_SECRET_LENGTH = 32
// Placeholder values that earlier presets and Console templates shipped in public source.
const PUBLIC_PLACEHOLDER_PROXY_SECRETS = ['replace-with-proxy-secret']

export function constantTimeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length
  const maxLength = Math.max(a.length, b.length)
  for (let i = 0; i < maxLength; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return mismatch === 0
}

function isPublicPlaceholderProxySecret(secret: string): boolean {
  return PUBLIC_PLACEHOLDER_PROXY_SECRETS.includes(secret.trim())
}

async function isPublicPlaceholderProxyDigest(digest: string): Promise<boolean> {
  const hashes = await Promise.all(
    PUBLIC_PLACEHOLDER_PROXY_SECRETS.map((secret) => sha256Hex(secret)),
  )
  return hashes.some((hash) => constantTimeEqual(hash, digest))
}

function assertTrustedProxySecretStrength(secret: string): void {
  if (
    secret.trim().length >= MIN_TRUSTED_PROXY_SECRET_LENGTH &&
    !isPublicPlaceholderProxySecret(secret)
  )
    return
  throw new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName: 'attribute_mapping._legacy.trustedProxySecret' },
    longMessage: 'header_trusted_proxy_secret_weak',
  })
}

function isTrustedProxyDigest(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(TRUSTED_PROXY_DIGEST_PREFIX) &&
    /^[0-9a-f]{64}$/.test(value.slice(TRUSTED_PROXY_DIGEST_PREFIX.length))
  )
}

export function trustedProxySecretConfigured(
  attributeMapping: Record<string, unknown> | null | undefined,
): boolean {
  const config = readLegacyConfigFromMapping(attributeMapping)
  return (
    Boolean(config.trustedProxySecret?.trim()) ||
    isTrustedProxyDigest(config.trustedProxySecretDigest)
  )
}

export function assertHeaderConnectionConfig(
  protocol: string,
  attributeMapping: Record<string, unknown> | null | undefined,
): void {
  if (protocol !== 'header') return
  if (trustedProxySecretConfigured(attributeMapping)) return
  throw new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName: 'attribute_mapping._legacy.trustedProxySecret' },
    longMessage: 'header_trusted_proxy_secret_required',
  })
}

export async function digestTrustedProxySecret(secret: string): Promise<string> {
  return `${TRUSTED_PROXY_DIGEST_PREFIX}${await sha256Hex(secret)}`
}

export async function verifyTrustedProxySecret(
  presented: string,
  config: LegacyConfig,
): Promise<{ valid: boolean; migrationDigest?: string }> {
  if (!presented) return { valid: false }
  const presentedHash = await sha256Hex(presented)
  if (isTrustedProxyDigest(config.trustedProxySecretDigest)) {
    const expected = config.trustedProxySecretDigest.slice(TRUSTED_PROXY_DIGEST_PREFIX.length)
    if (await isPublicPlaceholderProxyDigest(expected)) return { valid: false }
    return { valid: constantTimeEqual(presentedHash, expected) }
  }
  if (
    !config.trustedProxySecret?.trim() ||
    isPublicPlaceholderProxySecret(config.trustedProxySecret)
  ) {
    return { valid: false }
  }
  const legacyHash = await sha256Hex(config.trustedProxySecret)
  const valid = constantTimeEqual(presentedHash, legacyHash)
  return valid
    ? { valid: true, migrationDigest: `${TRUSTED_PROXY_DIGEST_PREFIX}${legacyHash}` }
    : { valid: false }
}

// Rewrites `legacy` in place: a submitted plaintext becomes a digest, otherwise the previous
// digest (or a digest of a previously stored non-placeholder plaintext) is carried over.
export async function prepareHeaderProxySecret(
  legacy: Record<string, unknown>,
  previousLegacy: Record<string, unknown>,
): Promise<void> {
  const plaintext =
    typeof legacy['trustedProxySecret'] === 'string' ? legacy['trustedProxySecret'] : undefined
  delete legacy['trustedProxySecret']
  delete legacy['trustedProxySecretDigest']
  if (plaintext !== undefined) {
    assertTrustedProxySecretStrength(plaintext)
    legacy['trustedProxySecretDigest'] = await digestTrustedProxySecret(plaintext)
    return
  }
  const previousDigest = previousLegacy['trustedProxySecretDigest']
  if (isTrustedProxyDigest(previousDigest)) {
    legacy['trustedProxySecretDigest'] = previousDigest
    return
  }
  const previousPlaintext = previousLegacy['trustedProxySecret']
  if (typeof previousPlaintext === 'string' && !isPublicPlaceholderProxySecret(previousPlaintext)) {
    legacy['trustedProxySecretDigest'] = await digestTrustedProxySecret(previousPlaintext)
  }
}
