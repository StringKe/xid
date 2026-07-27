import { argon2id } from '@noble/hashes/argon2.js'

const ARGON2_MEMORY_KB = 65536
const ARGON2_ITERATIONS = 3
const ARGON2_PARALLELISM = 1
const ARGON2_HASH_LENGTH = 32

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function decodePepper(raw) {
  const versioned = raw.match(/^v\d+:(.+)$/u)
  return Buffer.from(versioned?.[1] ?? raw, 'base64url')
}

export function hashSmokePassword(password, pepperRaw) {
  const pepper = decodePepper(pepperRaw)
  const passwordBytes = new TextEncoder().encode(password.slice(0, 128))
  const combined = new Uint8Array(pepper.length + passwordBytes.length)
  combined.set(pepper, 0)
  combined.set(passwordBytes, pepper.length)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const digest = argon2id(combined, salt, {
    m: ARGON2_MEMORY_KB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_HASH_LENGTH,
    version: 0x13,
  })
  return `$argon2id$v=19$m=${ARGON2_MEMORY_KB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}$${base64UrlEncode(salt)}$${base64UrlEncode(digest)}`
}
