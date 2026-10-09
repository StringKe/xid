// wsfed-token.ts:按 RSTR 解析 wresult,SAML 2.0 与 SAML 1.1 断言经 @xid-kit/saml 验签、Audience=wtrealm、有效期。

import { beforeAll, describe, expect, it } from 'vitest'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { isAppError } from '../../lib/errors'
import { buildFakeWresult, fakeWsfedSigner } from '../../test-harness/fake-wsfed-token'
import type { FakeWsfedTokenType } from '../../test-harness/fake-wsfed-token'
import { verifyWsfedWresult } from '../wsfed-token'

const ISSUER = 'http://127.0.0.1:8787/test-harness/fake-wsfed'
const REALM = 'urn:xid:test:wsfed'
const REPLY = 'https://tenant-1.xid.dev/sso/wsfed/conn-1/callback'
const TRUST_2005 = 'http://schemas.xmlsoap.org/ws/2005/02/trust'
const TRUST_13 = 'http://docs.oasis-open.org/ws-sx/ws-trust/200512'
const SAML2 = 'urn:oasis:names:tc:SAML:2.0:assertion'
const CLAIMS = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims'
const EMAIL = 'alice@corp.example'

let certificateB64 = ''
let privateKey: CryptoKey

beforeAll(async () => {
  const signer = await fakeWsfedSigner()
  certificateB64 = signer.certificateB64
  privateKey = signer.privateKey
})

function options(overrides: Record<string, unknown> = {}) {
  return {
    idpCertificatesB64: [certificateB64],
    expectedIssuer: ISSUER,
    realm: REALM,
    replyUrl: REPLY,
    clockSkewToleranceMs: 3 * 60 * 1000,
    attributeMapping: { email: `${CLAIMS}/emailaddress`, firstName: `${CLAIMS}/givenname` },
    ...overrides,
  }
}

function wresult(tokenType: FakeWsfedTokenType, overrides: { realm?: string; now?: number } = {}) {
  return buildFakeWresult({
    issuer: ISSUER,
    realm: overrides.realm ?? REALM,
    reply: REPLY,
    email: EMAIL,
    tokenType,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  })
}

function requestedToken(rstrXml: string): string {
  const doc = new DOMParser().parseFromString(rstrXml, 'text/xml')
  const token = doc.getElementsByTagNameNS(TRUST_2005, 'RequestedSecurityToken').item(0)
  const assertion = token?.firstChild
  if (!assertion) throw new Error('token missing')
  return new XMLSerializer().serializeToString(assertion)
}

function rstr(tokenXml: string): string {
  return `<t:RequestSecurityTokenResponse xmlns:t="${TRUST_2005}"><t:RequestedSecurityToken>${tokenXml}</t:RequestedSecurityToken></t:RequestSecurityTokenResponse>`
}

// AD FS 风格:默认命名空间写法、断言单独签名后放进 RSTR,SubjectConfirmationData 只有 NotOnOrAfter。
async function adfsStyleAssertion(recipient: string | null): Promise<string> {
  const now = Date.now()
  const at = (offset: number) => new Date(now + offset).toISOString()
  const recipientAttr = recipient === null ? '' : ` Recipient="${recipient}"`
  const xml = [
    `<Assertion xmlns="${SAML2}" ID="_adfs1" IssueInstant="${at(0)}" Version="2.0">`,
    `<Issuer>${ISSUER}</Issuer>`,
    `<Subject><NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${EMAIL}</NameID>`,
    `<SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><SubjectConfirmationData NotOnOrAfter="${at(5 * 60_000)}"${recipientAttr}/></SubjectConfirmation></Subject>`,
    `<Conditions NotBefore="${at(-60_000)}" NotOnOrAfter="${at(60 * 60_000)}"><AudienceRestriction><Audience>${REALM}</Audience></AudienceRestriction></Conditions>`,
    `<AuthnStatement AuthnInstant="${at(-30_000)}"><AuthnContext><AuthnContextClassRef>urn:federation:authentication:windows</AuthnContextClassRef></AuthnContext></AuthnStatement>`,
    `</Assertion>`,
  ].join('')
  const doc = Parse(xml)
  const signedXml = new SignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, doc, {
    references: [{ uri: '#_adfs1', hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const signature = signedXml.GetXml()
  if (!signature) throw new Error('signature missing')
  const issuer = doc.getElementsByTagNameNS(SAML2, 'Issuer').item(0)
  if (!issuer) throw new Error('issuer missing')
  doc.documentElement.insertBefore(signature, issuer.nextSibling)
  return rstr(Stringify(doc))
}

async function expectRejected(xml: string, code: string, extra: Record<string, unknown> = {}) {
  await expect(verifyWsfedWresult(xml, options(extra))).rejects.toSatisfy(
    (err: unknown) => isAppError(err) && err.code === code,
  )
}

describe('verifyWsfedWresult SAML 2.0', () => {
  it('accepts a signed assertion in a WS-Trust 2005 RSTR', async () => {
    const verified = await verifyWsfedWresult(await wresult('saml2'), options())

    expect(verified.subject.nameId).toBe(EMAIL)
    expect(verified.attributes).toMatchObject({ email: EMAIL, firstName: 'WSFed' })
  })

  it('accepts the WS-Trust 1.3 RSTR collection envelope', async () => {
    const token = requestedToken(await wresult('saml2'))
    const collection = `<trust:RequestSecurityTokenResponseCollection xmlns:trust="${TRUST_13}"><trust:RequestSecurityTokenResponse><trust:RequestedSecurityToken>${token}</trust:RequestedSecurityToken></trust:RequestSecurityTokenResponse></trust:RequestSecurityTokenResponseCollection>`

    const verified = await verifyWsfedWresult(collection, options())

    expect(verified.subject.nameId).toBe(EMAIL)
  })

  it('accepts a standalone-signed default-namespace AD FS assertion without Recipient', async () => {
    const verified = await verifyWsfedWresult(await adfsStyleAssertion(null), options())

    expect(verified.subject.nameId).toBe(EMAIL)
  })

  it('rejects a Recipient that is present but not the reply URL', async () => {
    await expectRejected(
      await adfsStyleAssertion('https://other.example/callback'),
      'recipient_mismatch',
    )
  })

  it('rejects a tampered assertion', async () => {
    const tampered = (await wresult('saml2')).replace(`>${EMAIL}<`, '>mallory@corp.example<')

    await expectRejected(tampered, 'signature_invalid')
  })

  it('rejects an assertion whose audience is not wtrealm', async () => {
    await expectRejected(await wresult('saml2', { realm: 'urn:other:realm' }), 'audience_mismatch')
  })

  it('rejects an expired assertion', async () => {
    await expectRejected(
      await wresult('saml2', { now: Date.now() - 3 * 60 * 60 * 1000 }),
      'assertion_expired',
    )
  })
})

describe('verifyWsfedWresult SAML 1.1', () => {
  const mapping = { email: `${CLAIMS}/emailaddress`, firstName: `${CLAIMS}/givenname` }

  it('accepts a signed SAML 1.1 assertion and maps namespaced attributes', async () => {
    const verified = await verifyWsfedWresult(
      await wresult('saml11'),
      options({ attributeMapping: mapping }),
    )

    expect(verified.subject.nameId).toBe(EMAIL)
    expect(verified.attributes).toMatchObject({ email: EMAIL, firstName: 'WSFed' })
    expect(verified.notOnOrAfter).toBeGreaterThan(Date.now())
  })

  it('rejects a tampered SAML 1.1 assertion', async () => {
    const tampered = (await wresult('saml11')).replaceAll(`>${EMAIL}<`, '>mallory@corp.example<')

    await expectRejected(tampered, 'signature_invalid')
  })

  it('rejects a SAML 1.1 assertion for another realm', async () => {
    await expectRejected(await wresult('saml11', { realm: 'urn:other:realm' }), 'audience_mismatch')
  })

  it('rejects a SAML 1.1 assertion from another issuer', async () => {
    await expectRejected(await wresult('saml11'), 'issuer_mismatch', {
      expectedIssuer: 'https://evil.example/adfs',
    })
  })

  it('rejects an expired SAML 1.1 assertion', async () => {
    await expectRejected(
      await wresult('saml11', { now: Date.now() - 3 * 60 * 60 * 1000 }),
      'assertion_expired',
    )
  })
})

describe('verifyWsfedWresult envelope', () => {
  it('rejects a bare samlp:Response that is not an RSTR', async () => {
    await expectRejected(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>`,
      'malformed_request',
    )
  })

  it('rejects an RSTR carrying more than one token', async () => {
    const token = requestedToken(await wresult('saml2'))

    await expectRejected(rstr(`${token}${token}`), 'malformed_request')
  })

  it('rejects a token type that is not a SAML assertion', async () => {
    await expectRejected(rstr('<x:Token xmlns:x="urn:example"/>'), 'malformed_request')
  })
})
