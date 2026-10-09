// wsfed-token.ts:生产路径按 RSTR 解析 wresult,断言经 @xid-kit/saml 验签、Audience=wtrealm、有效期。

import { beforeAll, describe, expect, it } from 'vitest'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { generateSelfSignedSamlCertificate, setSamlEngine, signSamlResponse } from '@xid-kit/saml'
import { isAppError } from '../../lib/errors'
import { verifyWsfedWresult } from '../wsfed-token'

const ISSUER = 'http://adfs.example.com/adfs/services/trust'
const REALM = 'urn:xid:test:wsfed'
const REPLY = 'https://tenant-1.xid.dev/sso/wsfed/conn-1/callback'
const TRUST_2005 = 'http://schemas.xmlsoap.org/ws/2005/02/trust'
const TRUST_13 = 'http://docs.oasis-open.org/ws-sx/ws-trust/200512'

let certificateB64 = ''
let privateKey: CryptoKey

beforeAll(async () => {
  setSamlEngine(globalThis.crypto)
  const generated = await generateSelfSignedSamlCertificate('adfs-test')
  if (!generated.ok) throw new Error(generated.error.reason)
  certificateB64 = generated.value.certificateB64
  privateKey = await crypto.subtle.importKey(
    'pkcs8',
    generated.value.privateKeyPkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
})

async function signedAssertionXml(overrides: { audience?: string; now?: number } = {}) {
  const signed = await signSamlResponse(
    {
      issuer: ISSUER,
      audience: overrides.audience ?? REALM,
      acsUrl: REPLY,
      subjectNameId: 'alice@corp.example',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributes: { upn: 'alice@corp.example', givenname: 'Alice' },
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
    },
    privateKey,
  )
  if (!signed.ok) throw new Error(signed.error.reason)
  const doc = new DOMParser().parseFromString(signed.value.xml, 'text/xml')
  const assertion = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Assertion')
  return new XMLSerializer().serializeToString(assertion.item(0)!)
}

function rstr(tokenXml: string, trustNs = TRUST_2005): string {
  return [
    `<t:RequestSecurityTokenResponse xmlns:t="${trustNs}">`,
    `<t:RequestedSecurityToken>${tokenXml}</t:RequestedSecurityToken>`,
    `</t:RequestSecurityTokenResponse>`,
  ].join('')
}

function rstrCollection(tokenXml: string): string {
  return [
    `<trust:RequestSecurityTokenResponseCollection xmlns:trust="${TRUST_13}">`,
    `<trust:RequestSecurityTokenResponse>`,
    `<trust:RequestedSecurityToken>${tokenXml}</trust:RequestedSecurityToken>`,
    `</trust:RequestSecurityTokenResponse>`,
    `</trust:RequestSecurityTokenResponseCollection>`,
  ].join('')
}

const OPTIONS = {
  get idpCertificatesB64() {
    return [certificateB64]
  },
  expectedIssuer: ISSUER,
  realm: REALM,
  replyUrl: REPLY,
  clockSkewToleranceMs: 3 * 60 * 1000,
  attributeMapping: { email: 'upn', firstName: 'givenname' },
}

async function expectRejected(xml: string, code: string): Promise<void> {
  await expect(verifyWsfedWresult(xml, OPTIONS)).rejects.toSatisfy(
    (err: unknown) => isAppError(err) && err.code === code,
  )
}

describe('verifyWsfedWresult', () => {
  it('accepts a signed SAML 2.0 assertion in a WS-Trust 2005 RSTR and maps attributes', async () => {
    const verified = await verifyWsfedWresult(rstr(await signedAssertionXml()), OPTIONS)

    expect(verified.subject.nameId).toBe('alice@corp.example')
    expect(verified.attributes).toMatchObject({ email: 'alice@corp.example', firstName: 'Alice' })
    expect(verified.notOnOrAfter).toBeGreaterThan(Date.now())
  })

  it('accepts the WS-Trust 1.3 RSTR collection envelope', async () => {
    const verified = await verifyWsfedWresult(rstrCollection(await signedAssertionXml()), OPTIONS)

    expect(verified.subject.nameId).toBe('alice@corp.example')
  })

  it('rejects a tampered assertion', async () => {
    const tampered = (await signedAssertionXml()).replace(
      'alice@corp.example</saml:NameID>',
      'mallory@corp.example</saml:NameID>',
    )

    await expectRejected(rstr(tampered), 'signature_invalid')
  })

  it('rejects an assertion whose audience is not wtrealm', async () => {
    await expectRejected(
      rstr(await signedAssertionXml({ audience: 'urn:other:realm' })),
      'audience_mismatch',
    )
  })

  it('rejects an expired assertion', async () => {
    await expectRejected(
      rstr(await signedAssertionXml({ now: Date.now() - 2 * 60 * 60 * 1000 })),
      'assertion_expired',
    )
  })

  it('rejects a bare samlp:Response that is not an RSTR', async () => {
    await expectRejected(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>`,
      'signature_invalid',
    )
  })

  it('rejects SAML 1.1 assertions explicitly', async () => {
    const saml11 = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:1.0:assertion" MajorVersion="1" MinorVersion="1" AssertionID="_a"/>`

    await expect(verifyWsfedWresult(rstr(saml11), OPTIONS)).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.longMessage === 'wsfed:saml11_unsupported',
    )
  })

  it('rejects an RSTR carrying more than one token', async () => {
    const assertion = await signedAssertionXml()

    await expectRejected(rstr(`${assertion}${assertion}`), 'signature_invalid')
  })
})
