// SAML 验签测试夹具:用真实 openssl 生成的 RSA 证书 + 私钥(idp.example.com)签 Response/Assertion。
// 证书 DER(base64)= connection 存的 IdP 证书;私钥 PKCS8(base64)= IdP 签名私钥(测试用)。
// 真实 IdP round-trip(Okta/Azure/Google)留上线前(04 章 8 step 4)。

import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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

// IdP 私钥导入(RSASSA-PKCS1-v1_5 / SHA-256),供测试签名 Response/Assertion。
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
    `<saml:Assertion ID="${p.assertionId}" Version="2.0" IssueInstant="2026-06-01T08:00:00Z">`,
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
  destination: ACS_URL,
  issuer: IDP_ENTITY_ID,
  audience: SP_ENTITY_ID,
  recipient: ACS_URL,
  subjectConfirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
  inResponseTo: '',
  notBefore: '2026-06-01T00:00:00Z',
  notOnOrAfter: '2030-06-01T00:00:00Z',
  subjConfirmExpiry: '2030-06-01T00:00:00Z',
  status: 'urn:oasis:names:tc:SAML:2.0:status:Success',
  email: 'user@example.com',
}

function withDefaults(p: ResponseParts): Required<ResponseParts> {
  const merged = { ...RESPONSE_DEFAULTS, ...p }
  // subjConfirmExpiry 默认跟随 notOnOrAfter(未单独指定时)。
  if (p.subjConfirmExpiry === undefined && p.notOnOrAfter !== undefined) {
    merged.subjConfirmExpiry = p.notOnOrAfter
  }
  return merged
}

// 构造未签名 Response XML(含一个 Assertion + Subject/NameID + Conditions + AttributeStatement)。
export function buildResponseXml(parts: ResponseParts = {}): string {
  const p = withDefaults(parts)
  return [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${ASSERT_NS}"`,
    ` ID="${p.responseId}" Version="2.0" IssueInstant="2026-06-01T08:00:00Z"${attr('Destination', p.destination)}${attr('InResponseTo', p.inResponseTo)}>`,
    `<saml:Issuer>${p.issuer}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${p.status}"/></samlp:Status>`,
    assertionXml(p),
    `</samlp:Response>`,
  ].join('')
}

// enveloped + exclusive-c14n 签某 ID 的元素,把 Signature 追加为该元素直接子节点。
async function signElement(doc: Document, target: Element, key: CryptoKey): Promise<void> {
  const id = target.getAttribute('ID') ?? ''
  const signedXml = new SignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, key, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const sig = signedXml.GetXml()
  if (!sig) throw new Error('signature not produced')
  target.appendChild(sig)
}

function firstChildByLocalName(parent: Element, localName: string): Element | null {
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1 && (node as Element).localName === localName)
      return node as Element
  }
  return null
}

// 签 Response 与/或 Assertion(Assertion 先签,Response 后签,保证 enveloped 嵌套正确)。
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
