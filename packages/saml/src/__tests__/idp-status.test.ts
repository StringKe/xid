// signSamlStatusResponse:错误状态 Response 的结构、签名与输入校验。

import { beforeAll, describe, expect, it } from 'vitest'
import { Parse } from 'xmldsigjs'
import { loadIdpVerifyKeys } from '../cert'
import { setSamlEngine } from '../engine'
import { SAML_STATUS, signSamlStatusResponse } from '../idp-status'
import { verifySignedElement } from '../structure'
import { IDP_CERT_B64, IDP_CERT_VALID_NOW, importIdpSigningKey } from './fixtures'
import { ASSERT_NS, DS_NS, SAMLP_NS, directChild } from './verify-helpers'

const ISSUER = 'https://acme.xid.dev/saml/idp/app_1'
const ACS = 'https://sp.example.com/acs'

let signKey: CryptoKey

async function verifyResponseSignature(xml: string) {
  const keys = await loadIdpVerifyKeys([IDP_CERT_B64], { now: IDP_CERT_VALID_NOW })
  if (!keys.ok) throw new Error(keys.error.reason)
  const doc = Parse(xml)
  return verifySignedElement(doc, doc.documentElement, keys.value)
}

describe('signSamlStatusResponse', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    signKey = await importIdpSigningKey()
  })

  it('signs a Responder/NoPassive Response with InResponseTo, Destination and Issuer and no assertion', async () => {
    const result = await signSamlStatusResponse(
      {
        issuer: ISSUER,
        destination: ACS,
        inResponseTo: '_req_1',
        topLevelStatus: SAML_STATUS.responder,
        secondLevelStatus: SAML_STATUS.noPassive,
        now: IDP_CERT_VALID_NOW,
      },
      signKey,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const root = Parse(result.value.xml).documentElement
    expect(root.getAttribute('ID')).toBe(result.value.responseId)
    expect(root.getAttribute('InResponseTo')).toBe('_req_1')
    expect(root.getAttribute('Destination')).toBe(ACS)
    expect(directChild(root, ASSERT_NS, 'Issuer')?.textContent).toBe(ISSUER)
    expect(directChild(root, ASSERT_NS, 'Assertion')).toBeUndefined()
    const top = directChild(
      directChild(root, SAMLP_NS, 'Status') as Element,
      SAMLP_NS,
      'StatusCode',
    )
    expect(top?.getAttribute('Value')).toBe(SAML_STATUS.responder)
    expect(directChild(top as Element, SAMLP_NS, 'StatusCode')?.getAttribute('Value')).toBe(
      SAML_STATUS.noPassive,
    )
    expect(atob(result.value.samlResponse)).toBe(result.value.xml)
    expect((await verifyResponseSignature(result.value.xml)).ok).toBe(true)
  })

  it('places the Response signature directly after Issuer', async () => {
    const result = await signSamlStatusResponse(
      {
        issuer: ISSUER,
        topLevelStatus: SAML_STATUS.requester,
        secondLevelStatus: SAML_STATUS.invalidNameIdPolicy,
      },
      signKey,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const root = Parse(result.value.xml).documentElement
    const issuer = directChild(root, ASSERT_NS, 'Issuer')
    let next = issuer?.nextSibling ?? null
    while (next && next.nodeType !== 1) next = next.nextSibling
    expect((next as Element | null)?.namespaceURI).toBe(DS_NS)
    expect((next as Element | null)?.localName).toBe('Signature')
  })

  it('omits the optional second-level code, Destination and InResponseTo when not given', async () => {
    const result = await signSamlStatusResponse(
      { issuer: ISSUER, topLevelStatus: SAML_STATUS.responder },
      signKey,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const root = Parse(result.value.xml).documentElement
    expect(root.hasAttribute('Destination')).toBe(false)
    expect(root.hasAttribute('InResponseTo')).toBe(false)
    const top = directChild(
      directChild(root, SAMLP_NS, 'Status') as Element,
      SAMLP_NS,
      'StatusCode',
    )
    expect(directChild(top as Element, SAMLP_NS, 'StatusCode')).toBeUndefined()
  })

  it('escapes XML metacharacters in InResponseTo', async () => {
    const result = await signSamlStatusResponse(
      { issuer: ISSUER, inResponseTo: '_a"><x/>', topLevelStatus: SAML_STATUS.requester },
      signKey,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Parse(result.value.xml).documentElement.getAttribute('InResponseTo')).toBe('_a"><x/>')
    }
  })

  it('fails signature verification after the status code is tampered', async () => {
    const result = await signSamlStatusResponse(
      {
        issuer: ISSUER,
        topLevelStatus: SAML_STATUS.responder,
        secondLevelStatus: SAML_STATUS.noPassive,
      },
      signKey,
    )
    if (!result.ok) throw new Error(result.error.reason)

    const tampered = result.value.xml.replace(SAML_STATUS.noPassive, SAML_STATUS.authnFailed)

    expect((await verifyResponseSignature(tampered)).ok).toBe(false)
  })

  it.each([
    ['a Success top-level code', { topLevelStatus: 'urn:oasis:names:tc:SAML:2.0:status:Success' }],
    ['a second-level code used as top-level', { topLevelStatus: SAML_STATUS.noPassive }],
    [
      'a non-SAML second-level code',
      { topLevelStatus: SAML_STATUS.responder, secondLevelStatus: 'urn:example:custom' },
    ],
  ])('malformed_request for %s', async (_label, status) => {
    const result = await signSamlStatusResponse({ issuer: ISSUER, ...status }, signKey)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_request')
  })
})
