// verifySamlResponse 测试共用:默认选项、签名 Response 构造与 XSW 注入片段。

import { Parse, Stringify } from 'xmldsigjs'
import { createSamlSignedXml } from '../signing'
import {
  ACS_URL,
  IDP_CERT_B64,
  IDP_CERT_VALID_NOW,
  IDP_ENTITY_ID,
  SP_ENTITY_ID,
  buildResponseXml,
  importIdpSigningKey,
  signResponse,
} from './fixtures'
import type { ResponseParts } from './fixtures'

// 无关证书,用于公钥不匹配用例。
export const OTHER_CERT_B64 =
  'MIICtDCCAZwCCQDnJfqAQozYiDANBgkqhkiG9w0BAQsFADAcMRowGAYDVQQDDBFvdGhlci5leGFtcGxlLmNvbTAeFw0yNjA2MDEyMDAzNTVaFw0yNzA2MDEyMDAzNTVaMBwxGjAYBgNVBAMMEW90aGVyLmV4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxuiqChBxRbzWh0Q7c7vTy5LocCnauxHVJMb0lAiFabDjnrb+1dLqVXOkfCNnrGHhcgr00JgjeVHNVbBwQVLOHnEKMqwAuxmMbn2kO8eRb6097JAJS3OqF5/g/9e+1PsHa0R/WWvoJT8xZ0XLHv9pxDiftO+yTL1zxidC4Y5bUhLTNO7/ZdyqWQ6i8kOjsyUEbdVSDNSHKOL+Uw4dUKV5n/HHaMFXvc2x8oBlb6xDbXLtl4bkJl8ukePzJSbvZKxVF/kSC6oqB073FunI3n9ZwurHsaCUAj9LOqeyEZBWAXq8+gcyQlbytdcp5c9bbMXZ7ADjt50FZ0jH3+WBJxc8RQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQB4W4hlYrpGhN1W2aY/oHzKbv/e+NR+HoAwmkc1ZFAmEcRrK9i8SJTXm42/BCXpraX4zBfG38Nkdcv617N/pQ1OE+aqsmZk3BopHdNVbBQqYvHpPOl4BVFzBgkhNyM3Y/weCWdTIffCBdZUSTNKDsW7MUqdayS6kQJ6W5TnouJwXOYLm4lheqaS5yoKL5VTkW+w9bvMxcNIMHMA4N24fnaKcNJ6ps0by/BFnxMidJnRw3QMlPDXZ/UAF5zPTDDMku5pp8HpOPvgeh+mRFgp35bMR7VLwvvxi9pOtkBjaB4PZtj6bpQkdmtr1kglxZanuUE67LTz0amLjMOYXiMn5ALF'

export const NOW = IDP_CERT_VALID_NOW
export const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
export const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
export const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
export const XENC_NS = 'http://www.w3.org/2001/04/xmlenc#'

export function opts(over: Record<string, unknown> = {}) {
  return {
    idpCertificatesB64: [IDP_CERT_B64],
    expectedIssuer: IDP_ENTITY_ID,
    expectedAudience: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    spInitiated: false,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    now: NOW,
    ...over,
  }
}

let signKey: CryptoKey | undefined

export async function idpSignKey(): Promise<CryptoKey> {
  signKey ??= await importIdpSigningKey()
  return signKey
}

export async function signedResponse(
  parts: ResponseParts = {},
  signOpts = { response: true, assertion: true },
): Promise<string> {
  return signResponse(buildResponseXml(parts), await idpSignKey(), signOpts)
}

export async function signedMutatedResponse(
  mutate: (xml: string) => string,
  signOpts = { response: true, assertion: true },
): Promise<string> {
  return signResponse(mutate(buildResponseXml()), await idpSignKey(), signOpts)
}

export function extractSignedAssertion(responseXml: string): string {
  const start = responseXml.indexOf('<saml:Assertion ')
  const end = responseXml.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length
  return responseXml.slice(start, end)
}

// 在原 Assertion 前注入片段(XSW 包装位置)。
export function injectBeforeAssertion(responseXml: string, fragment: string): string {
  const at = responseXml.indexOf('<saml:Assertion ')
  return responseXml.slice(0, at) + fragment + responseXml.slice(at)
}

export function standaloneAssertion(assertionXml: string): string {
  if (assertionXml.includes('xmlns:saml=')) return assertionXml
  return assertionXml.replace('<saml:Assertion ', `<saml:Assertion xmlns:saml="${ASSERT_NS}" `)
}

export async function signStandaloneAssertion(assertionXml: string): Promise<string> {
  const doc = Parse(assertionXml)
  const id = doc.documentElement.getAttribute('ID') ?? ''
  const signedXml = createSamlSignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, await idpSignKey(), doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const sig = signedXml.GetXml()
  if (!sig) throw new Error('signature not produced')
  const issuer = directChild(doc.documentElement, ASSERT_NS, 'Issuer')
  doc.documentElement.insertBefore(sig, issuer?.nextSibling ?? doc.documentElement.firstChild)
  return Stringify(doc)
}

export function directChild(parent: Element, ns: string, localName: string): Element | undefined {
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const node = parent.childNodes.item(index)
    if (node?.nodeType !== 1) continue
    const element = node as Element
    if (element.namespaceURI === ns && element.localName === localName) return element
  }
  return undefined
}

export function forgedAssertion(id: string, email: string): string {
  return [
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="2026-06-01T08:00:00Z">`,
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress">${email}</saml:NameID>`,
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`,
    `<saml:SubjectConfirmationData Recipient="${ACS_URL}" NotOnOrAfter="2030-06-01T00:00:00Z"/>`,
    `</saml:SubjectConfirmation></saml:Subject>`,
    `<saml:Conditions NotBefore="2026-06-01T00:00:00Z" NotOnOrAfter="2030-06-01T00:00:00Z">`,
    `<saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction>`,
    `</saml:Conditions></saml:Assertion>`,
  ].join('')
}

export function b64(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
