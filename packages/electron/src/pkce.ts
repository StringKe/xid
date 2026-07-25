// PKCE S256 helpers -- pure functions, no Electron/Node imports.
// Uses Web Crypto (crypto.subtle) per crypto-boundary rule.
// Called from the main process before opening the system browser.
//
// RFC 7636: code_verifier = high-entropy random string (43-128 chars, UNRESERVED)
//           code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
//           method = S256 (plain is rejected per oidc-oauth rule)

import type { PkceChallenge } from './types'
import { randomString } from '@xid-kit/crypto'

// Alphabet: unreserved chars per RFC 3986 minus the chars that need special
// handling; using the same character set as most reference implementations.
const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
const VERIFIER_LENGTH = 64

/**
 * Generate a PKCE code verifier + S256 challenge.
 * Caller must pass a crypto implementation (allows Node crypto.webcrypto in
 * main process and window.crypto in renderer/test environments).
 */
export async function generatePkceChallenge(
  subtle: SubtleCrypto,
  randomValues: (arr: Uint8Array) => Uint8Array,
): Promise<PkceChallenge> {
  const codeVerifier = generateVerifier(randomValues)
  const codeChallenge = await computeS256(subtle, codeVerifier)
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' }
}

function generateVerifier(randomValues: (arr: Uint8Array) => Uint8Array): string {
  return randomString(VERIFIER_LENGTH, VERIFIER_CHARS, randomValues)
}

async function computeS256(subtle: SubtleCrypto, verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await subtle.digest('SHA-256', encoded)
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(bytes: Uint8Array): string {
  // Convert Uint8Array to base64 via String.fromCharCode + btoa.
  // btoa is available in both Node 16+ (globalThis.btoa) and browsers.
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Build the state parameter: a random URL-safe string for CSRF protection.
 * Stored by the caller alongside the code_verifier before launching the browser.
 */
export function generateState(randomValues: (arr: Uint8Array) => Uint8Array): string {
  const bytes = randomValues(new Uint8Array(32))
  return base64UrlEncode(bytes)
}

/**
 * Construct the OIDC authorization URL.
 * Always uses PKCE S256 and authorization_code flow (Shared native contract).
 */
export function buildAuthorizeUrl(params: {
  issuer: string
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  codeChallenge: string
  state: string
  prompt?: string
}): URL {
  const url = new URL('/authorize', params.issuer)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('scope', params.scopes.join(' '))
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', params.state)
  if (params.prompt) url.searchParams.set('prompt', params.prompt)
  return url
}

/**
 * Extract the authorization code and state from the callback URL.
 * Returns null if the URL contains an error response instead.
 */
export function parseCallbackUrl(callbackUrl: URL): {
  code: string
  state: string
} | null {
  const error = callbackUrl.searchParams.get('error')
  if (error) return null
  const code = callbackUrl.searchParams.get('code')
  const state = callbackUrl.searchParams.get('state')
  if (!code || !state) return null
  return { code, state }
}
