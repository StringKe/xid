// 用 openssl 生成的 RSA 夹具证书/私钥签 Response/Assertion(真 IdP round-trip 上线前另做)。

import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fromBER } from 'asn1js'
import { Certificate } from 'pkijs'
import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { toBufferSource } from '@xid-kit/crypto'

export const IDP_ENTITY_ID = 'https://idp.example.com/metadata'
export const SP_ENTITY_ID = 'https://acme.xid.dev/saml/conn_1'
export const ACS_URL = 'https://acme.xid.dev/sso/saml/conn_1/acs'

const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'

function createIdpFixture(): { certificate: string; privateKey: Uint8Array } {
  const directory = mkdtempSync(join(tmpdir(), 'xid-saml-fixture-'))
  const keyPath = join(directory, 'idp-key.pem')
  const certificatePath = join(directory, 'idp-cert.der')
  try {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(keyPath, keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const result = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-new',
        '-key',
        keyPath,
        '-subj',
        '/CN=idp.example.com',
        '-days',
        '1',
        '-outform',
        'DER',
        '-out',
        certificatePath,
      ],
      { encoding: 'utf8' },
    )
    if (result.error || result.status !== 0)
      throw new Error('openssl test certificate generation failed')
    return {
      certificate: readFileSync(certificatePath).toString('base64'),
      privateKey: new Uint8Array(keyPair.privateKey.export({ format: 'der', type: 'pkcs8' })),
    }
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

const idpFixture = createIdpFixture()
export const IDP_CERT_B64 = idpFixture.certificate
export const IDP_CERT_VALID_NOW = Date.now()

export function certificateWithValidity(
  certificateB64: string,
  notBefore: number,
  notAfter: number,
): string {
  const der = Uint8Array.from(Buffer.from(certificateB64, 'base64'))
  const asn1 = fromBER(toBufferSource(der))
  if (asn1.offset === -1) throw new Error('invalid fixture certificate')
  const certificate = new Certificate({ schema: asn1.result })
  certificate.notBefore.value = new Date(notBefore)
  certificate.notAfter.value = new Date(notAfter)
  return Buffer.from(certificate.toSchema(true).toBER(false)).toString('base64')
}

export async function importIdpSigningKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    toBufferSource(idpFixture.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

export type ResponseParts = {
  responseId?: string
  assertionId?: string
  issueInstant?: string
  authnInstant?: string
  destination?: string
  issuer?: string
  audience?: string
  recipient?: string
  subjectConfirmationMethod?: string
  inResponseTo?: string
  notBefore?: string
  notOnOrAfter?: string
  subjConfirmExpiry?: string
  status?: string
  email?: string
}

function assertionXml(p: Required<ResponseParts>): string {
  return [
    `<saml:Assertion ID="${p.assertionId}" Version="2.0" IssueInstant="${p.issueInstant}">`,
    `<saml:Issuer>${p.issuer}</saml:Issuer>`,
    `<saml:Subject>`,
    `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress">${p.email}</saml:NameID>`,
    `<saml:SubjectConfirmation Method="${p.subjectConfirmationMethod}">`,
    `<saml:SubjectConfirmationData Recipient="${p.recipient}"${attr('InResponseTo', p.inResponseTo)} NotOnOrAfter="${p.subjConfirmExpiry}"/>`,
    `</saml:SubjectConfirmation>`,
    `</saml:Subject>`,
    `<saml:Conditions NotBefore="${p.notBefore}" NotOnOrAfter="${p.notOnOrAfter}">`,
    `<saml:AudienceRestriction><saml:Audience>${p.audience}</saml:Audience></saml:AudienceRestriction>`,
    `</saml:Conditions>`,
    `<saml:AuthnStatement AuthnInstant="${p.authnInstant}" SessionIndex="_session_0001">`,
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml:AuthnContextClassRef></saml:AuthnContext>`,
    `</saml:AuthnStatement>`,
    `<saml:AttributeStatement>`,
    `<saml:Attribute Name="email"><saml:AttributeValue>${p.email}</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="firstName"><saml:AttributeValue>Bjorn</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="groups"><saml:AttributeValue>eng</saml:AttributeValue><saml:AttributeValue>admin</saml:AttributeValue></saml:Attribute>`,
    `</saml:AttributeStatement>`,
    `</saml:Assertion>`,
  ].join('')
}

function attr(name: string, value: string): string {
  return value ? ` ${name}="${value}"` : ''
}

const RESPONSE_DEFAULTS: Required<ResponseParts> = {
  responseId: '_resp_0001',
  assertionId: '_assert_0001',
  issueInstant: new Date(IDP_CERT_VALID_NOW).toISOString(),
  authnInstant: new Date(IDP_CERT_VALID_NOW).toISOString(),
  destination: ACS_URL,
  issuer: IDP_ENTITY_ID,
  audience: SP_ENTITY_ID,
  recipient: ACS_URL,
  subjectConfirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
  inResponseTo: '',
  notBefore: new Date(IDP_CERT_VALID_NOW - 60 * 1000).toISOString(),
  notOnOrAfter: new Date(IDP_CERT_VALID_NOW + 5 * 60 * 1000).toISOString(),
  subjConfirmExpiry: new Date(IDP_CERT_VALID_NOW + 5 * 60 * 1000).toISOString(),
  status: 'urn:oasis:names:tc:SAML:2.0:status:Success',
  email: 'user@example.com',
}

function withDefaults(p: ResponseParts): Required<ResponseParts> {
  const merged = { ...RESPONSE_DEFAULTS, ...p }
  // 未单独指定时,subjConfirmExpiry 跟随 notOnOrAfter。
  if (p.subjConfirmExpiry === undefined && p.notOnOrAfter !== undefined) {
    merged.subjConfirmExpiry = p.notOnOrAfter
  }
  return merged
}

export function buildResponseXml(parts: ResponseParts = {}): string {
  const p = withDefaults(parts)
  return [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${ASSERT_NS}"`,
    ` ID="${p.responseId}" Version="2.0" IssueInstant="${p.issueInstant}"${attr('Destination', p.destination)}${attr('InResponseTo', p.inResponseTo)}>`,
    `<saml:Issuer>${p.issuer}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${p.status}"/></samlp:Status>`,
    assertionXml(p),
    `</samlp:Response>`,
  ].join('')
}

// Signature 须紧跟 Issuer,与生产接收 allowlist 顺序一致。
async function signElement(doc: Document, target: Element, key: CryptoKey): Promise<void> {
  const id = target.getAttribute('ID') ?? ''
  const signedXml = new SignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, key, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const sig = signedXml.GetXml()
  if (!sig) throw new Error('signature not produced')
  const issuer = firstChildByLocalName(target, 'Issuer')
  target.insertBefore(sig, issuer?.nextSibling ?? target.firstChild)
}

function firstChildByLocalName(parent: Element, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1 && (node as Element).localName === localName)
      return node as Element
  }
  return null
}

// Assertion 先签、Response 后签,保证 enveloped 嵌套正确。
export async function signResponse(
  xml: string,
  key: CryptoKey,
  opts: { response: boolean; assertion: boolean },
): Promise<string> {
  const doc = Parse(xml)
  if (opts.assertion) {
    const assertion = firstChildByLocalName(doc.documentElement, 'Assertion')
    if (assertion) await signElement(doc, assertion, key)
  }
  if (opts.response) {
    await signElement(doc, doc.documentElement, key)
  }
  return Stringify(doc)
}
