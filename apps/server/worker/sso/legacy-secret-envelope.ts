// KEK envelope for legacy SSO secrets that must be decryptable at runtime (LDAP gateway secret,
// SWA vaulted credentials). Stored as JSON inside sso_connections.attribute_mapping.

import { envelopeDecrypt, envelopeEncrypt } from '@xid-kit/crypto'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { decodeKek } from '../oidc/shared'

const KEK_VERSION = 1

const storedEnvelopeSchema = v.object({
  iv: v.pipe(v.string(), v.minLength(1)),
  ciphertext: v.pipe(v.string(), v.minLength(1)),
  tag: v.pipe(v.string(), v.minLength(1)),
  kekVersion: v.number(),
})

export type StoredEnvelope = v.InferOutput<typeof storedEnvelopeSchema>

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0))
}

function requireKek(env: { KEK: string }): Uint8Array {
  if (!env.KEK) throw new AppError('server_error', { longMessage: 'kek_unavailable' })
  return decodeKek(env.KEK)
}

export function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  return v.safeParse(storedEnvelopeSchema, value).success
}

export async function sealLegacySecret(
  env: { KEK: string },
  plaintext: string,
): Promise<StoredEnvelope> {
  const blob = await envelopeEncrypt(
    new TextEncoder().encode(plaintext),
    requireKek(env),
    KEK_VERSION,
  )
  return {
    iv: toBase64(blob.iv),
    ciphertext: toBase64(blob.ciphertext),
    tag: toBase64(blob.tag),
    kekVersion: blob.kekVersion,
  }
}

export async function openLegacySecret(
  env: { KEK: string },
  envelope: StoredEnvelope,
): Promise<string> {
  try {
    const plaintext = await envelopeDecrypt(
      {
        iv: fromBase64(envelope.iv),
        ciphertext: fromBase64(envelope.ciphertext),
        tag: fromBase64(envelope.tag),
        kekVersion: envelope.kekVersion,
      },
      requireKek(env),
    )
    const text = new TextDecoder().decode(plaintext)
    plaintext.fill(0)
    return text
  } catch (cause) {
    throw new AppError('server_error', { cause, longMessage: 'legacy_secret_unreadable' })
  }
}
