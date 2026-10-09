// verifySaml11Assertion:ADFS 风格 SAML 1.1 令牌的验签、有效期、受众、主体与属性提取,以及负向用例。

import { beforeAll, describe, expect, it } from 'vitest'
import { Parse, Reference, SignedXml, Stringify } from 'xmldsigjs'
import type { DigestReferenceSource } from 'xmldsigjs'
import { setSamlEngine } from '../engine'
import { verifySaml11Assertion } from '../saml11'
import { IDP_CERT_B64, IDP_CERT_VALID_NOW, importIdpSigningKey } from './fixtures'
import { OTHER_CERT_B64 } from './verify-helpers'

const NOW = IDP_CERT_VALID_NOW
const S = 'urn:oasis:names:tc:SAML:1.0:assertion'
const ISSUER = 'http://adfs.example.com/adfs/services/trust'
const AUDIENCE = 'https://acme.xid.dev/wsfed/conn_1'
const CLAIMS = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims'
const BEARER = 'urn:oasis:names:tc:SAML:1.0:cm:bearer'

type Parts = {
  assertionId?: string
  issuer?: string
  audience?: string
  notBefore?: string
  notOnOrAfter?: string
  authnInstant?: string
  confirmationMethod?: string
  attributeSubject?: string
}

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString()
}

function subjectXml(nameId: string, method: string): string {
  return `<saml:Subject><saml:NameIdentifier Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${nameId}</saml:NameIdentifier><saml:SubjectConfirmation><saml:ConfirmationMethod>${method}</saml:ConfirmationMethod></saml:SubjectConfirmation></saml:Subject>`
}

function assertionXml(parts: Parts = {}): string {
  const method = parts.confirmationMethod ?? BEARER
  return [
    `<saml:Assertion xmlns:saml="${S}" MajorVersion="1" MinorVersion="1" AssertionID="${parts.assertionId ?? '_a11_1'}" Issuer="${parts.issuer ?? ISSUER}" IssueInstant="${iso(-30_000)}">`,
    `<saml:Conditions NotBefore="${parts.notBefore ?? iso(-60_000)}" NotOnOrAfter="${parts.notOnOrAfter ?? iso(60 * 60_000)}">`,
    `<saml:AudienceRestrictionCondition><saml:Audience>${parts.audience ?? AUDIENCE}</saml:Audience></saml:AudienceRestrictionCondition>`,
    `</saml:Conditions>`,
    `<saml:AttributeStatement>${subjectXml(parts.attributeSubject ?? 'ACME\\user', method)}`,
    `<saml:Attribute AttributeName="emailaddress" AttributeNamespace="${CLAIMS}"><saml:AttributeValue>user@example.com</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute AttributeName="givenname" AttributeNamespace="${CLAIMS}"><saml:AttributeValue>Bjorn</saml:AttributeValue></saml:Attribute>`,
    `</saml:AttributeStatement>`,
    `<saml:AuthenticationStatement AuthenticationMethod="urn:federation:authentication:windows" AuthenticationInstant="${parts.authnInstant ?? iso(-6 * 60 * 60_000)}">${subjectXml('ACME\\user', method)}</saml:AuthenticationStatement>`,
    `</saml:Assertion>`,
  ].join('')
}

// 测试端签名:xmldsigjs 按 Id/ID/id 查找引用,SAML 1.1 用 AssertionID,故摘要时临时以根元素为输入。
class AssertionIdSignedXml extends SignedXml {
  protected override async DigestReference(
    source: DigestReferenceSource,
    reference: Reference,
    checkHmac: boolean,
  ): Promise<Uint8Array> {
    const uri = reference.Uri
    reference.Uri = ''
    try {
      return await super.DigestReference(source, reference, checkHmac)
    } finally {
      reference.Uri = uri
    }
  }
}

let signKey: CryptoKey

async function sign(xml: string): Promise<string> {
  const doc = Parse(xml)
  const id = doc.documentElement.getAttribute('AssertionID') ?? ''
  const signedXml = new AssertionIdSignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, signKey, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const signature = signedXml.GetXml()
  if (!signature) throw new Error('signature not produced')
  doc.documentElement.appendChild(signature)
  return Stringify(doc)
}

function verify(xml: string, over: Record<string, unknown> = {}) {
  return verifySaml11Assertion(xml, {
    idpCertificatesB64: [IDP_CERT_B64],
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
    attributeMapping: { email: `${CLAIMS}/emailaddress`, firstName: `${CLAIMS}/givenname` },
    now: NOW,
    ...over,
  })
}

describe('verifySaml11Assertion', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    signKey = await importIdpSigningKey()
  })

  it('accepts a signed ADFS-style SAML 1.1 token and extracts subject and claims', async () => {
    const result = await verify(await sign(assertionXml()))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.assertionId).toBe('_a11_1')
      expect(result.value.issuer).toBe(ISSUER)
      expect(result.value.subject.nameId).toBe('ACME\\user')
      expect(result.value.attributes.email).toBe('user@example.com')
      expect(result.value.attributes.firstName).toBe('Bjorn')
      expect(result.value.notOnOrAfter).toBe(Date.parse(iso(60 * 60_000)))
      expect(result.value.signingCertFingerprint.length).toBeGreaterThan(0)
    }
  })

  it('signature_required when the assertion carries no signature', async () => {
    const result = await verify(assertionXml())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('signature_invalid when a signed claim is tampered', async () => {
    const tampered = (await sign(assertionXml())).replace(
      'user@example.com',
      'attacker@evil.example.com',
    )

    const result = await verify(tampered)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('signature_invalid when the Reference points at an AssertionID other than the root', async () => {
    const signed = await sign(assertionXml())
    const retargeted = signed.replace('URI="#_a11_1"', 'URI="#_other"')

    const result = await verify(retargeted)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('signature_invalid when verified with an unrelated certificate', async () => {
    const result = await verify(await sign(assertionXml()), {
      idpCertificatesB64: [OTHER_CERT_B64],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it.each([
    ['issuer_mismatch', { issuer: 'http://evil.example.com/adfs/services/trust' }],
    ['audience_mismatch', { audience: 'https://other.example.com/wsfed' }],
    ['assertion_expired', { notOnOrAfter: iso(-3 * 60_000 - 1) }],
    ['assertion_expired', { notBefore: iso(3 * 60_000 + 1) }],
    ['assertion_expired', { authnInstant: iso(3 * 60_000 + 1) }],
    ['recipient_mismatch', { confirmationMethod: 'urn:oasis:names:tc:SAML:1.0:cm:holder-of-key' }],
    ['schema_invalid', { attributeSubject: 'ACME\\someone-else' }],
  ] as const)('%s for a signed token with %o', async (code, parts) => {
    const result = await verify(await sign(assertionXml(parts)))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(code)
  })

  it.each([
    [
      'Advice',
      (xml: string) => xml.replace('</saml:Conditions>', '</saml:Conditions><saml:Advice/>'),
    ],
    [
      'a SAML 1.0 MinorVersion',
      (xml: string) => xml.replace('MinorVersion="1"', 'MinorVersion="0"'),
    ],
    ['missing Conditions NotOnOrAfter', (xml: string) => xml.replace(/ NotOnOrAfter="[^"]*"/, '')],
  ])('rejects a signed token with %s', async (_label, mutate) => {
    const result = await verify(await sign(mutate(assertionXml())))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(['schema_invalid', 'assertion_expired']).toContain(result.error.code)
  })

  it('malformed_xml when a SAML 2.0 assertion is passed to the SAML 1.1 verifier', async () => {
    const saml2 = assertionXml().replace(
      `xmlns:saml="${S}"`,
      'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"',
    )

    const result = await verify(saml2)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_xml')
  })
})
