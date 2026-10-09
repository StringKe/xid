import { describe, expect, it, vi } from 'vitest'
import { NAME_ID_FORMAT, chooseNameIdFormat, nameIdValue } from '../outbound-saml-name-id'

const SAML2_EMAIL = 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'

function valueInput(overrides: Partial<Parameters<typeof nameIdValue>[0]> = {}) {
  return {
    format: NAME_ID_FORMAT.persistent,
    email: 'user@example.com',
    username: 'user',
    persistentNameId: vi.fn().mockResolvedValue('stored-pseudonym'),
    ...overrides,
  }
}

describe('chooseNameIdFormat', () => {
  it('uses the configured format when the request has no NameIDPolicy format', () => {
    const choice = chooseNameIdFormat({ configuredFormat: SAML2_EMAIL, requestedFormat: undefined })

    expect(choice).toEqual({ ok: true, format: SAML2_EMAIL })
  })

  it('uses the configured format when the request asks for unspecified', () => {
    const choice = chooseNameIdFormat({
      configuredFormat: NAME_ID_FORMAT.persistent,
      requestedFormat: NAME_ID_FORMAT.unspecified,
    })

    expect(choice).toEqual({ ok: true, format: NAME_ID_FORMAT.persistent })
  })

  it('honours a supported format requested by the SP', () => {
    const choice = chooseNameIdFormat({
      configuredFormat: SAML2_EMAIL,
      requestedFormat: NAME_ID_FORMAT.transient,
    })

    expect(choice).toEqual({ ok: true, format: NAME_ID_FORMAT.transient })
  })

  it('rejects an unsupported requested format', () => {
    const choice = chooseNameIdFormat({
      configuredFormat: SAML2_EMAIL,
      requestedFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName',
    })

    expect(choice).toEqual({ ok: false, cause: 'requested_format_unsupported' })
  })

  it('rejects an unsupported configured format', () => {
    const choice = chooseNameIdFormat({
      configuredFormat: 'urn:example:custom',
      requestedFormat: undefined,
    })

    expect(choice).toEqual({ ok: false, cause: 'configured_format_unsupported' })
  })
})

describe('nameIdValue', () => {
  it('returns the email for emailAddress in both SAML 1.1 and 2.0 namespaces', async () => {
    const legacy = await nameIdValue(valueInput({ format: SAML2_EMAIL }))
    const standard = await nameIdValue(valueInput({ format: NAME_ID_FORMAT.emailAddress }))

    expect([legacy, standard]).toEqual(['user@example.com', 'user@example.com'])
  })

  it('returns null for emailAddress when the user has no email', async () => {
    const value = await nameIdValue(valueInput({ format: SAML2_EMAIL, email: null }))

    expect(value).toBeNull()
  })

  it('falls back to the username for unspecified when the user has no email', async () => {
    const value = await nameIdValue(valueInput({ format: NAME_ID_FORMAT.unspecified, email: null }))

    expect(value).toBe('user')
  })

  it('returns the stored persistent value for persistent', async () => {
    const value = await nameIdValue(valueInput())

    expect(value).toBe('stored-pseudonym')
  })

  it('does not touch the persistent mapping for other formats', async () => {
    const input = valueInput({ format: SAML2_EMAIL })

    await nameIdValue(input)

    expect(input.persistentNameId).not.toHaveBeenCalled()
  })

  it('generates a fresh transient value for every assertion', async () => {
    const first = await nameIdValue(valueInput({ format: NAME_ID_FORMAT.transient }))
    const second = await nameIdValue(valueInput({ format: NAME_ID_FORMAT.transient }))

    expect(first).not.toBe(second)
    expect(first).toMatch(/^_[A-Za-z0-9_-]+$/)
  })
})
