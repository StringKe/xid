// PKCE S256 纯函数：仅 Web Crypto，无 Electron/Node 依赖；plain 按协议规则拒绝。

import type { PkceChallenge } from './types'
import { randomString } from '@xid-kit/crypto'

// RFC 3986 unreserved 字符集，与常见实现一致。
const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
const VERIFIER_LENGTH = 64

// @types/node 将 getRandomValues 特化为 Uint8Array<ArrayBuffer>，调用方可能仍是 ArrayBufferLike，在此归一。
export type RandomValuesFn = (arr: Uint8Array) => Uint8Array

export async function generatePkceChallenge(
  subtle: SubtleCrypto,
  randomValues: RandomValuesFn,
): Promise<PkceChallenge> {
  const codeVerifier = generateVerifier(randomValues)
  const codeChallenge = await computeS256(subtle, codeVerifier)
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' }
}

function generateVerifier(randomValues: RandomValuesFn): string {
  return randomString(VERIFIER_LENGTH, VERIFIER_CHARS, (bytes) => {
    randomValues(bytes)
  })
}

async function computeS256(subtle: SubtleCrypto, verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await subtle.digest('SHA-256', encoded)
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function generateState(randomValues: RandomValuesFn): string {
  const bytes = randomValues(new Uint8Array(32))
  return base64UrlEncode(bytes)
}

// 固定 authorization_code + S256，与 Shared native 契约一致。
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
