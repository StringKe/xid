// saml-errors.ts 单测:SamlErrorCode -> SsoErrorCode + HTTP 状态映射(对照 04 章 8.8 错误分支表)。

import { describe, it, expect } from 'vitest'
import { samlErrorToApp } from '../saml-errors'
import { isAppError } from '../../lib/errors'

describe('samlErrorToApp 映射 8.8', () => {
  const cases: [Parameters<typeof samlErrorToApp>[0], string, number][] = [
    ['malformed_request', 'malformed_request', 400],
    ['malformed_xml', 'malformed_xml', 400],
    ['schema_invalid', 'schema_invalid', 400],
    ['signature_required', 'signature_required', 401],
    ['signature_invalid', 'signature_invalid', 401],
    ['weak_algorithm', 'signature_invalid', 401],
    ['decryption_failed', 'decryption_failed', 400],
    ['issuer_mismatch', 'issuer_mismatch', 403],
    ['audience_mismatch', 'audience_mismatch', 403],
    ['assertion_expired', 'assertion_expired', 403],
    ['recipient_mismatch', 'recipient_mismatch', 403],
    ['replay_detected', 'replay_detected', 403],
    ['idp_status_error', 'idp_status_error', 403],
  ]

  for (const [input, expectedCode, expectedStatus] of cases) {
    it(`${input} -> ${expectedCode} (${expectedStatus})`, () => {
      const err = samlErrorToApp(input, 'reason detail')
      expect(isAppError(err)).toBe(true)
      expect(err.code).toBe(expectedCode)
      expect(err.httpStatus).toBe(expectedStatus)
    })
  }

  it('内部 reason 进 cause 不外泄(longMessage 仅 saml:<code>)', () => {
    const err = samlErrorToApp('signature_invalid', 'digest mismatch internal')
    expect(err.longMessage).toBe('saml:signature_invalid')
    expect(err.cause).toBe('digest mismatch internal')
  })
})
