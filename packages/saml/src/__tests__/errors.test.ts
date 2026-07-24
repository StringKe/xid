import { describe, it, expect } from 'vitest'

import { failResult, okResult, samlFail, SAML_ERROR_CODES } from '../errors'

describe('SAML Result helpers', () => {
  it('covers all documented error codes', () => {
    expect(SAML_ERROR_CODES).toContain('signature_invalid')
    expect(SAML_ERROR_CODES).toContain('replay_detected')
  })

  it('builds ok and fail results', () => {
    expect(okResult(42)).toEqual({ ok: true, value: 42 })
    expect(failResult('issuer_mismatch', 'bad issuer')).toEqual({
      ok: false,
      error: { code: 'issuer_mismatch', reason: 'bad issuer' },
    })
  })

  it('attaches idpStatus when provided', () => {
    expect(samlFail('idp_status_error', 'denied', 'urn:fail')).toEqual({
      code: 'idp_status_error',
      reason: 'denied',
      idpStatus: 'urn:fail',
    })
  })
})
