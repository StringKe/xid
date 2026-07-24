// SAML IdP 输出:metadata + signed Response。用于 XID 作为下游 SaaS 的 IdP。
// XML-DSig 仍走 xmldsigjs + Web Crypto,不手写签名。

import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { SAML_ASSERTION_NS, SAMLP_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const PROTO = 'urn:oasis:names:tc:SAML:2.0:protocol'
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const SUBJECT_CONFIRMATION_BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer'

export type IdpMetadataInput = {
  entityId: string
  ssoUrl: string
  sloUrl?: string
  signingCertsB64: readonly string[]
  nameIdFormats?: readonly string[]
}

export type SamlAttributeValue = string | readonly string[]

export type SamlResponseInput = {
  issuer: string
  audience: string
  acsUrl: string
  subjectNameId: string
  nameIdFormat: string
  attributes: Record<string, SamlAttributeValue>
  sessionIndex?: string
  inResponseTo?: string
  now?: number
  ttlMs?: number
}

export type SignedSamlResponse = {
  responseId: string
  assertionId: string
  xml: string
  samlResponse: string
}

const DEFAULT_NAMEID_FORMATS = [
  'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
]

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function samlId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `_${prefix}_${hex}`
}

function instant(ms: number): string {
  return new Date(ms).toISOString()
}

function certDescriptor(certB64: string): string {
  const cert = certB64.replace(/\s+/g, '')
  return [
    `<md:KeyDescriptor use="signing">`,
    `<ds:KeyInfo xmlns:ds="${DS_NS}"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`,
    `</md:KeyDescriptor>`,
  ].join('')
}

export function buildIdpMetadataXml(input: IdpMetadataInput): string {
  const formats = input.nameIdFormats ?? DEFAULT_NAMEID_FORMATS
  const certs = input.signingCertsB64.map((cert) => certDescriptor(cert)).join('')
  const nameIdFormats = formats
    .map((format) => `<md:NameIDFormat>${escapeXml(format)}</md:NameIDFormat>`)
    .join('')
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="${escapeXml(input.entityId)}">`,
    `<md:IDPSSODescriptor protocolSupportEnumeration="${PROTO}" WantAuthnRequestsSigned="false">`,
    certs,
    nameIdFormats,
    `<md:SingleSignOnService Binding="${POST_BINDING}" Location="${escapeXml(input.ssoUrl)}"/>`,
    ...(input.sloUrl
      ? [
          `<md:SingleLogoutService Binding="${POST_BINDING}" Location="${escapeXml(input.sloUrl)}"/>`,
          `<md:SingleLogoutService Binding="${REDIRECT_BINDING}" Location="${escapeXml(input.sloUrl)}"/>`,
        ]
      : []),
    `</md:IDPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join('')
}

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeXml(value)}"` : ''
}

function attributeValues(value: SamlAttributeValue): string {
  const values = Array.isArray(value) ? value : [value]
  return values
    .map((item) => `<saml:AttributeValue>${escapeXml(item)}</saml:AttributeValue>`)
    .join('')
}

function authnStatement(input: SamlResponseInput & { sessionIndex: string }): string {
  const issuedAt = instant(input.now ?? Date.now())
  return `<saml:AuthnStatement AuthnInstant="${issuedAt}" SessionIndex="${escapeXml(input.sessionIndex)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
}

function attributeStatement(input: SamlResponseInput): string {
  const attrs = Object.entries(input.attributes)
    .filter(([name]) => name.length > 0)
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${escapeXml(name)}">${attributeValues(value)}</saml:Attribute>`,
    )
    .join('')
  return attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : ''
}

export function buildSamlResponseXml(input: SamlResponseInput): {
  responseId: string
  assertionId: string
  sessionIndex: string
  xml: string
} {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? 5 * 60 * 1000
  const notBefore = instant(now - 60 * 1000)
  const notOnOrAfter = instant(now + ttlMs)
  const responseId = samlId('response')
  const assertionId = samlId('assertion')
  const sessionIndex = input.sessionIndex ?? samlId('session')
  const issuedAt = instant(now)
  const inResponseToAttr = attr('InResponseTo', input.inResponseTo)
  const xml = [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_ASSERTION_NS}"`,
    ` ID="${responseId}" Version="2.0" IssueInstant="${issuedAt}" Destination="${escapeXml(input.acsUrl)}"${inResponseToAttr}>`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${STATUS_SUCCESS}"/></samlp:Status>`,
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issuedAt}">`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    `<saml:Subject>`,
    `<saml:NameID Format="${escapeXml(input.nameIdFormat)}">${escapeXml(input.subjectNameId)}</saml:NameID>`,
    `<saml:SubjectConfirmation Method="${SUBJECT_CONFIRMATION_BEARER}">`,
    `<saml:SubjectConfirmationData Recipient="${escapeXml(input.acsUrl)}"${inResponseToAttr} NotOnOrAfter="${notOnOrAfter}"/>`,
    `</saml:SubjectConfirmation>`,
    `</saml:Subject>`,
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">`,
    `<saml:AudienceRestriction><saml:Audience>${escapeXml(input.audience)}</saml:Audience></saml:AudienceRestriction>`,
    `</saml:Conditions>`,
    attributeStatement(input),
    authnStatement({ ...input, sessionIndex }),
    `</saml:Assertion>`,
    `</samlp:Response>`,
  ].join('')
  return { responseId, assertionId, sessionIndex, xml }
}

async function signElement(doc: Document, target: Element, key: CryptoKey): Promise<void> {
  const id = target.getAttribute('ID') ?? ''
  const signedXml = new SignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, key, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const sig = signedXml.GetXml()
  if (!sig) throw new Error('SAML signature not produced')
  target.appendChild(sig)
}

function childByLocalName(parent: Element, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1 && (node as Element).localName === localName) {
      return node as Element
    }
  }
  return null
}

function xmlToBase64(xml: string): string {
  const bytes = new TextEncoder().encode(xml)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function signSamlResponse(
  input: SamlResponseInput,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedSamlResponse>> {
  try {
    const built = buildSamlResponseXml(input)
    const doc = Parse(built.xml)
    const assertion = childByLocalName(doc.documentElement, 'Assertion')
    if (!assertion) return failResult('schema_invalid', 'Assertion missing')
    await signElement(doc, assertion, privateKey)
    await signElement(doc, doc.documentElement, privateKey)
    const xml = Stringify(doc)
    return okResult({
      responseId: built.responseId,
      assertionId: built.assertionId,
      xml,
      samlResponse: xmlToBase64(xml),
    })
  } catch (cause) {
    return failResult('signature_invalid', `SAML Response sign failed: ${String(cause)}`)
  }
}
