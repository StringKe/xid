// XID 作为 IdP 发出的签名:SignedInfo 用 exclusive C14N,被签断言脱离原 Response 外壳后仍可验签。

import { beforeAll, describe, expect, it } from 'vitest'
import { Parse, Stringify } from 'xmldsigjs'
import { loadIdpVerifyKeys } from '../cert'
import { setSamlEngine } from '../engine'
import { signSamlResponse } from '../idp'
import { verifySignedElement } from '../structure'
import { IDP_CERT_B64, IDP_CERT_VALID_NOW, IDP_ENTITY_ID, importIdpSigningKey } from './fixtures'
import { ASSERT_NS, directChild } from './verify-helpers'

const EXCLUSIVE_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'
const INCLUSIVE_C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'

async function signedResponseXml(): Promise<string> {
  const signed = await signSamlResponse(
    {
      issuer: IDP_ENTITY_ID,
      audience: 'https://sp.example/saml',
      acsUrl: 'https://sp.example/acs',
      subjectNameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      attributes: { email: 'user@example.com' },
      now: IDP_CERT_VALID_NOW,
    },
    await importIdpSigningKey(),
  )
  if (!signed.ok) throw new Error(signed.error.reason)
  return signed.value.xml
}

describe('signSamlResponse canonicalization', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('canonicalizes both SignedInfo elements with exclusive C14N', async () => {
    const xml = await signedResponseXml()

    expect(
      xml.match(new RegExp(`CanonicalizationMethod Algorithm="${EXCLUSIVE_C14N}"`, 'g')),
    ).toHaveLength(2)
    expect(xml).not.toContain(INCLUSIVE_C14N)
  })

  it('keeps the assertion signature valid after the assertion is moved into a different document', async () => {
    const assertion = directChild(
      Parse(await signedResponseXml()).documentElement,
      ASSERT_NS,
      'Assertion',
    )
    if (!assertion) throw new Error('Assertion missing')
    const moved = Parse(
      `<wrapper xmlns="urn:example:other" xmlns:x="urn:example:x">${Stringify(assertion)}</wrapper>`,
    )
    const movedAssertion = directChild(moved.documentElement, ASSERT_NS, 'Assertion')
    const keys = await loadIdpVerifyKeys([IDP_CERT_B64], { now: IDP_CERT_VALID_NOW })
    if (!movedAssertion || !keys.ok) throw new Error('fixture setup failed')

    const result = await verifySignedElement(moved, movedAssertion, keys.value)

    expect(result.ok).toBe(true)
  })
})
