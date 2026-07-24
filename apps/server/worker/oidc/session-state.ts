// OIDC Session Management session_state helpers (OP iframe + authorize).

import { base64UrlEncode } from '@xid-kit/crypto'

const encoder = new TextEncoder()

function sessionStateDigest(parts: string[]): string {
  return parts.join(' ')
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return base64UrlEncode(new Uint8Array(digest))
}

export async function computeBrowserState(input: {
  clientId: string
  issuer: string
  sessionKey: string
  salt: string
}): Promise<string> {
  return sha256Base64Url(
    sessionStateDigest([input.clientId, input.issuer, input.sessionKey, input.salt]),
  )
}

export async function computeSessionState(input: {
  clientId: string
  issuer: string
  browserState: string
  salt: string
}): Promise<string> {
  return sha256Base64Url(
    sessionStateDigest([input.clientId, input.issuer, input.browserState, input.salt]),
  )
}

export async function computeOpSessionState(input: {
  clientId: string
  issuer: string
  sessionKey: string
  salt: string
}): Promise<string> {
  const browserState = await computeBrowserState(input)
  return computeSessionState({
    clientId: input.clientId,
    issuer: input.issuer,
    browserState,
    salt: input.salt,
  })
}
