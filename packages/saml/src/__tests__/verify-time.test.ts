// verifySamlResponse 时间语义:Conditions、SubjectConfirmationData、AuthnStatement 各自的时间字段。

import { beforeAll, describe, expect, it } from 'vitest'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import { NOW, opts, signedMutatedResponse, signedResponse } from './verify-helpers'

const AUTHN_STATEMENT_PATTERN = /<saml:AuthnStatement\b[^>]*>[\s\S]*?<\/saml:AuthnStatement>/

describe('verifySamlResponse time semantics', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('assertion_expired when NotOnOrAfter passed', async () => {
    const xml = await signedResponse({ notOnOrAfter: new Date(NOW - 60 * 60 * 1000).toISOString() })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('assertion_expired')
  })

  it('assertion_expired when SubjectConfirmationData NotOnOrAfter passed', async () => {
    const result = await verifySamlResponse(
      await signedResponse({
        subjConfirmExpiry: new Date(NOW - 3 * 60 * 1000 - 1).toISOString(),
      }),
      opts(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('assertion_expired')
  })

  it('accepts a future SubjectConfirmationData expiry inside the signed freshness window', async () => {
    const result = await verifySamlResponse(
      await signedResponse({
        subjConfirmExpiry: new Date(NOW + 2 * 60 * 1000).toISOString(),
      }),
      opts(),
    )
    expect(result.ok).toBe(true)
  })

  it('schema_invalid when the login Assertion has no AuthnStatement', async () => {
    const xml = await signedMutatedResponse((unsigned) =>
      unsigned.replace(AUTHN_STATEMENT_PATTERN, ''),
    )
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('schema_invalid when the login Assertion has duplicate AuthnStatement elements', async () => {
    const xml = await signedMutatedResponse((unsigned) =>
      unsigned.replace(AUTHN_STATEMENT_PATTERN, (statement) => statement + statement),
    )
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('schema_invalid when AuthnInstant is malformed', async () => {
    const result = await verifySamlResponse(
      await signedResponse({ authnInstant: 'not-a-date' }),
      opts(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('schema_invalid when AuthnInstant is missing', async () => {
    const xml = await signedMutatedResponse((unsigned) =>
      unsigned.replace(/(<saml:AuthnStatement\b[^>]*?) AuthnInstant="[^"]*"/, '$1'),
    )
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('assertion_expired when AuthnInstant is later than the clock-skew window', async () => {
    const result = await verifySamlResponse(
      await signedResponse({
        authnInstant: new Date(NOW + 3 * 60 * 1000 + 1).toISOString(),
      }),
      opts(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('assertion_expired')
  })

  it('assertion_expired when AuthnInstant predates the signed freshness window', async () => {
    const notBefore = NOW - 60 * 1000
    const result = await verifySamlResponse(
      await signedResponse({
        notBefore: new Date(notBefore).toISOString(),
        authnInstant: new Date(notBefore - 3 * 60 * 1000 - 1).toISOString(),
      }),
      opts(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('assertion_expired')
  })

  it('accepts AuthnInstant at the future clock-skew boundary', async () => {
    const result = await verifySamlResponse(
      await signedResponse({
        authnInstant: new Date(NOW + 3 * 60 * 1000).toISOString(),
      }),
      opts(),
    )
    expect(result.ok).toBe(true)
  })
})
