import { describe, expect, it } from 'vitest'
import { computeBrowserState, computeOpSessionState, computeSessionState } from '../session-state'

/** Mirrors the inline /check_session iframe JS (OIDC Session Management). */
async function iframeSha256Base64Url(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function iframeOpSessionState(input: {
  clientId: string
  issuer: string
  sessionKey: string
  salt: string
}): Promise<string> {
  const browserState = await iframeSha256Base64Url(
    `${input.clientId} ${input.issuer} ${input.sessionKey} ${input.salt}`,
  )
  return iframeSha256Base64Url(`${input.clientId} ${input.issuer} ${browserState} ${input.salt}`)
}

describe('session-state', () => {
  const vector = {
    clientId: 'rp_client',
    issuer: 'https://acme.xid.dev',
    sessionKey: 's_test_123',
    salt: 'salt-fixed',
  }

  it('matches iframe JS algorithm for browser and OP session_state', async () => {
    const browserState = await computeBrowserState(vector)
    const iframeBrowser = await iframeSha256Base64Url(
      `${vector.clientId} ${vector.issuer} ${vector.sessionKey} ${vector.salt}`,
    )
    expect(browserState).toBe(iframeBrowser)

    const opState = await computeOpSessionState(vector)
    const iframeOp = await iframeOpSessionState(vector)
    expect(opState).toBe(iframeOp)
  })

  it('produces deterministic OP session_state for known vectors', async () => {
    const opState = await computeOpSessionState(vector)
    expect(opState).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await computeOpSessionState(vector)).toBe(opState)
    expect(
      await computeOpSessionState({
        ...vector,
        sessionKey: '',
      }),
    ).not.toBe(opState)
  })

  it('chains browserState into session_state per OIDC spec', async () => {
    const browserState = await computeBrowserState(vector)
    const sessionState = await computeSessionState({
      clientId: vector.clientId,
      issuer: vector.issuer,
      browserState,
      salt: vector.salt,
    })
    expect(sessionState).toBe(await computeOpSessionState(vector))
  })
})
