// AuthnRequest 标准可选元素与属性(SAML Core 3.4.1),以及 ForceAuthn/IsPassive/NameIDPolicy 的解析。

import { beforeAll, describe, expect, it } from 'vitest'
import { generateAuthnRequest, verifySamlAuthnRequest } from '../authn-request'
import { setSamlEngine } from '../engine'
import { SP_ENTITY_ID } from './fixtures'

const IDP_SSO_URL = 'https://idp.example.com/sso'
const ACS_URL = 'https://sp.example.com/acs'
const NAME_ID_POLICY = /<samlp:NameIDPolicy [^>]*\/>/
const REQUESTED_AUTHN_CONTEXT =
  '<samlp:RequestedAuthnContext Comparison="exact"><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></samlp:RequestedAuthnContext>'
const SCOPING =
  '<samlp:Scoping ProxyCount="1"><samlp:IDPList><samlp:IDPEntry ProviderID="https://idp.example.com/metadata"/></samlp:IDPList><samlp:RequesterID>https://requester.example.com</samlp:RequesterID></samlp:Scoping>'
const EXTENSIONS =
  '<samlp:Extensions><ext:Hint xmlns:ext="urn:example:ext">x</ext:Hint></samlp:Extensions>'
const CONDITIONS =
  '<saml:Conditions NotOnOrAfter="2030-01-01T00:00:00Z"><saml:AudienceRestriction><saml:Audience>https://idp.example.com/metadata</saml:Audience></saml:AudienceRestriction></saml:Conditions>'

function requestXml(mutate: (xml: string) => string = (xml) => xml): string {
  const request = generateAuthnRequest({
    spEntityId: SP_ENTITY_ID,
    idpSsoUrl: IDP_SSO_URL,
    acsUrl: ACS_URL,
  })
  return mutate(request.xml)
}

function withoutAttribute(xml: string, name: string): string {
  return xml.replace(new RegExp(` ${name}="[^"]*"`), '')
}

function verify(xml: string) {
  return verifySamlAuthnRequest(xml, {
    expectedIssuer: SP_ENTITY_ID,
    expectedDestination: IDP_SSO_URL,
    expectedAcsUrl: ACS_URL,
  })
}

describe('verifySamlAuthnRequest optional SAML Core elements', () => {
  beforeAll(() => {
    setSamlEngine(globalThis.crypto)
  })

  it('accepts Extensions, NameIDPolicy, Conditions, RequestedAuthnContext and Scoping in schema order', async () => {
    const xml = requestXml((raw) =>
      raw
        .replace('<samlp:NameIDPolicy', `${EXTENSIONS}<samlp:NameIDPolicy`)
        .replace(
          NAME_ID_POLICY,
          (policy) => `${policy}${CONDITIONS}${REQUESTED_AUTHN_CONTEXT}${SCOPING}`,
        ),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(true)
  })

  it('accepts a Slack-style RequestedAuthnContext with minimum comparison', async () => {
    const xml = requestXml((raw) =>
      raw.replace(
        NAME_ID_POLICY,
        (policy) => policy + REQUESTED_AUTHN_CONTEXT.replace('exact', 'minimum'),
      ),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(true)
  })

  it('falls back to the registered ACS and HTTP-POST when the request names neither', async () => {
    const xml = requestXml((raw) =>
      withoutAttribute(withoutAttribute(raw, 'AssertionConsumerServiceURL'), 'ProtocolBinding'),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.acsUrl).toBe(ACS_URL)
  })

  it('accepts AssertionConsumerServiceIndex and AttributeConsumingServiceIndex instead of an ACS URL', async () => {
    const xml = requestXml((raw) =>
      withoutAttribute(
        withoutAttribute(raw, 'AssertionConsumerServiceURL'),
        'ProtocolBinding',
      ).replace(
        '<samlp:AuthnRequest ',
        '<samlp:AuthnRequest AssertionConsumerServiceIndex="0" AttributeConsumingServiceIndex="1" ',
      ),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.acsUrl).toBe(ACS_URL)
  })

  it('accepts a request without NameIDPolicy and reports a null policy', async () => {
    const result = await verify(requestXml((raw) => raw.replace(NAME_ID_POLICY, '')))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.nameIdPolicy).toBeNull()
  })

  it.each([
    [
      'Subject',
      (xml: string) =>
        xml.replace(
          '<samlp:NameIDPolicy',
          '<saml:Subject><saml:NameID>victim@example.com</saml:NameID></saml:Subject><samlp:NameIDPolicy',
        ),
    ],
    [
      'Extensions in a SAML namespace',
      (xml: string) =>
        xml.replace(
          '<samlp:NameIDPolicy',
          '<samlp:Extensions><saml:Attribute Name="x"/></samlp:Extensions><samlp:NameIDPolicy',
        ),
    ],
    [
      'an unknown Comparison',
      (xml: string) =>
        xml.replace(
          NAME_ID_POLICY,
          (policy) => policy + REQUESTED_AUTHN_CONTEXT.replace('exact', 'loosest'),
        ),
    ],
    [
      'mixed ClassRef and DeclRef',
      (xml: string) =>
        xml.replace(
          NAME_ID_POLICY,
          (policy) =>
            policy +
            REQUESTED_AUTHN_CONTEXT.replace(
              '</samlp:RequestedAuthnContext>',
              '<saml:AuthnContextDeclRef>urn:x</saml:AuthnContextDeclRef></samlp:RequestedAuthnContext>',
            ),
        ),
    ],
    [
      'Scoping before RequestedAuthnContext',
      (xml: string) =>
        xml.replace(NAME_ID_POLICY, (policy) => policy + SCOPING + REQUESTED_AUTHN_CONTEXT),
    ],
    [
      'a duplicated NameIDPolicy',
      (xml: string) => xml.replace(NAME_ID_POLICY, (policy) => policy + policy),
    ],
    [
      'both ACS URL and ACS index',
      (xml: string) =>
        xml.replace(
          '<samlp:AuthnRequest ',
          '<samlp:AuthnRequest AssertionConsumerServiceIndex="0" ',
        ),
    ],
    [
      'a non-numeric ACS index',
      (xml: string) =>
        withoutAttribute(
          withoutAttribute(xml, 'AssertionConsumerServiceURL'),
          'ProtocolBinding',
        ).replace(
          '<samlp:AuthnRequest ',
          '<samlp:AuthnRequest AssertionConsumerServiceIndex="first" ',
        ),
    ],
  ])('schema_invalid for %s', async (_label, mutate) => {
    const result = await verify(requestXml(mutate))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('recipient_mismatch when Destination is absent', async () => {
    const result = await verify(requestXml((raw) => withoutAttribute(raw, 'Destination')))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('recipient_mismatch when a present ProtocolBinding is not HTTP-POST', async () => {
    const xml = requestXml((raw) =>
      raw.replace(
        /ProtocolBinding="[^"]*"/,
        'ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact"',
      ),
    )

    const result = await verify(xml)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('schema_invalid when Issuer is missing', async () => {
    const result = await verify(
      requestXml((raw) => raw.replace(/<saml:Issuer>[^<]*<\/saml:Issuer>/, '')),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
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
