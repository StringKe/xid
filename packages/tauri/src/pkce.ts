// PKCE S256 utilities for Tauri WebView context.
// Uses Web Crypto (crypto.subtle) available in Tauri's WebView -- no Node/native APIs.
// All functions are pure and side-effect-free; randomness is injected via getRandomValues.
// PKCE downgrade protection: only S256 is generated and accepted (plain is never produced).

export type PkceChallenge = {
  verifier: string
  challenge: string
  method: 'S256'
}

// Generate a cryptographically random base64url string of the given byte length.
// byteLength must be >= 32 (PKCE spec: verifier entropy >= 256 bits).
export function generateBase64UrlRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

// Derive S256 code_challenge from verifier: BASE64URL(SHA-256(ASCII(verifier))).
export async function deriveS256Challenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return encodeBase64Url(new Uint8Array(digest))
}

// Generate a full PKCE pair (verifier + S256 challenge) in one call.
export async function generatePkce(): Promise<PkceChallenge> {
  // verifier: 64 random bytes -> 86-char base64url (>= 43 chars required by spec, max 128)
  const verifier = generateBase64UrlRandom(64)
  const challenge = await deriveS256Challenge(verifier)
  return { verifier, challenge, method: 'S256' }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}
