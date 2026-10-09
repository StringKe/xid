// verifySamlAuthnRequest 返回值:RequestedAuthnContext、ForceAuthn、IsPassive、NameIDPolicy 的解析。

import { beforeAll, describe, expect, it } from 'vitest'
import { setSamlEngine } from '../engine'
import { NAME_ID_POLICY, requestXml, verify } from './authn-request-helpers'

describe('verifySamlAuthnRequest RequestedAuthnContext parsing', () => {
  beforeAll(() => {
    setSamlEngine(globalThis.crypto)
  })

  it('returns RequestedAuthnContext comparison and every AuthnContextClassRef', async () => {
    const context =
      '<samlp:RequestedAuthnContext Comparison="minimum"><saml:AuthnContextClassRef>urn:a</saml:AuthnContextClassRef><saml:AuthnContextClassRef>urn:b</saml:AuthnContextClassRef></samlp:RequestedAuthnContext>'
    const xml = requestXml((raw) => raw.replace(NAME_ID_POLICY, (policy) => policy + context))

    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.requestedAuthnContext).toEqual({
        comparison: 'minimum',
        classRefs: ['urn:a', 'urn:b'],
        declRefs: [],
      })
    }
  })

  it('defaults RequestedAuthnContext comparison to exact and reports DeclRefs separately', async () => {
    const context =
      '<samlp:RequestedAuthnContext><saml:AuthnContextDeclRef>urn:decl</saml:AuthnContextDeclRef></samlp:RequestedAuthnContext>'
    const xml = requestXml((raw) => raw.replace(NAME_ID_POLICY, (policy) => policy + context))

    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.requestedAuthnContext).toEqual({
        comparison: 'exact',
        classRefs: [],
        declRefs: ['urn:decl'],
      })
    }
  })

  it('returns a null RequestedAuthnContext when the request has none', async () => {
    const result = await verify(requestXml())

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.requestedAuthnContext).toBeNull()
  })
})

describe('verifySamlAuthnRequest ForceAuthn, IsPassive and NameIDPolicy parsing', () => {
  beforeAll(() => {
    setSamlEngine(globalThis.crypto)
  })

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('reads ForceAuthn="%s" and IsPassive="%s" as %s', async (value, expected) => {
    const xml = requestXml((raw) =>
      raw.replace(
        '<samlp:AuthnRequest ',
        `<samlp:AuthnRequest ForceAuthn="${value}" IsPassive="${value}" `,
      ),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.forceAuthn).toBe(expected)
      expect(result.value.isPassive).toBe(expected)
    }
  })

  it('defaults ForceAuthn and IsPassive to false when absent', async () => {
    const result = await verify(requestXml())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.forceAuthn).toBe(false)
      expect(result.value.isPassive).toBe(false)
    }
  })

  it('schema_invalid when ForceAuthn is not an XML boolean', async () => {
    const xml = requestXml((raw) =>
      raw.replace('<samlp:AuthnRequest ', '<samlp:AuthnRequest ForceAuthn="yes" '),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('reads a NameIDPolicy with Format but without AllowCreate', async () => {
    const xml = requestXml((raw) =>
      raw.replace(
        NAME_ID_POLICY,
        '<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"/>',
      ),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.nameIdPolicy).toEqual({
        format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      })
    }
  })

  it('reads a NameIDPolicy with AllowCreate="0" and no Format', async () => {
    const xml = requestXml((raw) =>
      raw.replace(NAME_ID_POLICY, '<samlp:NameIDPolicy AllowCreate="0"/>'),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.nameIdPolicy).toEqual({ allowCreate: false })
  })
})
