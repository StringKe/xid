import { describe, expect, it } from 'vitest'
import { otpSendStatus, turnstileGate, turnstilePasses } from './turnstile-gate'

const configured = {
  configSettled: true,
  siteKey: 'site-key',
  token: null,
  needsInteraction: false,
}

describe('turnstileGate', () => {
  it('keeps protected actions closed until the auth config settles', () => {
    const gate = turnstileGate({ ...configured, configSettled: false, siteKey: null })

    expect(gate).toBe('checking')
    expect(turnstilePasses(gate)).toBe(false)
  })

  it('passes without a widget when Turnstile is not configured', () => {
    const gate = turnstileGate({ ...configured, siteKey: null })

    expect(gate).toBe('off')
    expect(turnstilePasses(gate)).toBe(true)
  })

  it('stays closed during a silent check', () => {
    expect(turnstileGate(configured)).toBe('checking')
  })

  it('reports that the visitor must interact when the widget asks for it', () => {
    const gate = turnstileGate({ ...configured, needsInteraction: true })

    expect(gate).toBe('needs_interaction')
    expect(turnstilePasses(gate)).toBe(false)
  })

  it('opens once the widget produced a token', () => {
    const gate = turnstileGate({ ...configured, token: 'token-1', needsInteraction: true })

    expect(gate).toBe('ready')
    expect(turnstilePasses(gate)).toBe(true)
  })
})

describe('otpSendStatus', () => {
  it('reports sent as soon as a send succeeded, even while a new check is pending', () => {
    const status = otpSendStatus({ sentAt: 1, requestInFlight: false, gate: 'needs_interaction' })

    expect(status).toBe('sent')
  })

  it('waits for the visitor instead of claiming the code is being sent', () => {
    const status = otpSendStatus({
      sentAt: null,
      requestInFlight: false,
      gate: 'needs_interaction',
    })

    expect(status).toBe('awaiting_check')
  })

  it('reports sending while the request is in flight or the check runs silently', () => {
    expect(otpSendStatus({ sentAt: null, requestInFlight: true, gate: 'ready' })).toBe('sending')
    expect(otpSendStatus({ sentAt: null, requestInFlight: false, gate: 'checking' })).toBe(
      'sending',
    )
  })
})
