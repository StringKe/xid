// 本地 WS-Fed 假 IdP 的令牌签发:按 WS-Federation 1.2 第 13 节发 wst:RequestSecurityTokenResponse,
// 内含签名的 SAML 2.0 或 SAML 1.1 断言,与真实 AD FS / Entra 走同一条生产验证路径。
// 签名密钥在 isolate 内生成,证书通过 /test-harness/fake-wsfed/certificate 提供给连接配置。

import { generateSelfSignedSamlCertificate, setSamlEngine, signSamlResponse } from '@xid-kit/saml'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { Parse, Reference, SignedXml, Stringify } from 'xmldsigjs'
import type { DigestReferenceSource } from 'xmldsigjs'

export type FakeWsfedTokenType = 'saml2' | 'saml11'

export type FakeWsfedTokenInput = {
  issuer: string
  realm: string
  reply: string
  email: string
  tokenType: FakeWsfedTokenType
  now?: number
}

type FakeSigner = { certificateB64: string; privateKey: CryptoKey }

const WS_TRUST_2005 = 'http://schemas.xmlsoap.org/ws/2005/02/trust'
const SAML2_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
const SAML11_NS = 'urn:oasis:names:tc:SAML:1.0:assertion'
const CLAIMS_NS = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims'
const SAML11_BEARER = 'urn:oasis:names:tc:SAML:1.0:cm:bearer'
const TOKEN_TTL_MS = 60 * 60 * 1000

// SAML 1.1 断言的 ID 属性是 AssertionID,xmldsigjs 只按 Id/ID/id 解析引用,摘要时以根元素为输入。
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

let signerPromise: Promise<FakeSigner> | null = null

async function createSigner(): Promise<FakeSigner> {
  setSamlEngine(globalThis.crypto)
  const generated = await generateSelfSignedSamlCertificate('xid-fake-wsfed')
  if (!generated.ok) throw new Error(generated.error.reason)
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(generated.value.privateKeyPkcs8),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return { certificateB64: generated.value.certificateB64, privateKey }
}

export function fakeWsfedSigner(): Promise<FakeSigner> {
  signerPromise ??= createSigner()
  return signerPromise
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function saml2Assertion(input: FakeWsfedTokenInput, signer: FakeSigner): Promise<string> {
  const signed = await signSamlResponse(
    {
      issuer: input.issuer,
      audience: input.realm,
      acsUrl: input.reply,
      subjectNameId: input.email,
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributes: {
        [`${CLAIMS_NS}/emailaddress`]: input.email,
        [`${CLAIMS_NS}/givenname`]: 'WSFed',
        [`${CLAIMS_NS}/surname`]: 'User',
      },
      ttlMs: TOKEN_TTL_MS,
      ...(input.now === undefined ? {} : { now: input.now }),
    },
    signer.privateKey,
  )
  if (!signed.ok) throw new Error(signed.error.reason)
  const doc = new DOMParser().parseFromString(signed.value.xml, 'text/xml')
  const assertion = doc.getElementsByTagNameNS(SAML2_NS, 'Assertion').item(0)
  if (!assertion) throw new Error('fake WS-Fed SAML 2.0 assertion missing')
  return new XMLSerializer().serializeToString(assertion)
}

function saml11Subject(email: string): string {
  return [
    `<saml:Subject>`,
    `<saml:NameIdentifier Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escapeXml(email)}</saml:NameIdentifier>`,
    `<saml:SubjectConfirmation><saml:ConfirmationMethod>${SAML11_BEARER}</saml:ConfirmationMethod></saml:SubjectConfirmation>`,
    `</saml:Subject>`,
  ].join('')
}

function saml11Attribute(name: string, value: string): string {
  return `<saml:Attribute AttributeName="${name}" AttributeNamespace="${CLAIMS_NS}"><saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue></saml:Attribute>`
}

async function saml11Assertion(input: FakeWsfedTokenInput, signer: FakeSigner): Promise<string> {
  const now = input.now ?? Date.now()
  const id = `_fake-wsfed-${crypto.randomUUID()}`
  const xml = [
    `<saml:Assertion xmlns:saml="${SAML11_NS}" MajorVersion="1" MinorVersion="1" AssertionID="${id}" Issuer="${escapeXml(input.issuer)}" IssueInstant="${new Date(now).toISOString()}">`,
    `<saml:Conditions NotBefore="${new Date(now - 60_000).toISOString()}" NotOnOrAfter="${new Date(now + TOKEN_TTL_MS).toISOString()}">`,
    `<saml:AudienceRestrictionCondition><saml:Audience>${escapeXml(input.realm)}</saml:Audience></saml:AudienceRestrictionCondition>`,
    `</saml:Conditions>`,
    `<saml:AttributeStatement>${saml11Subject(input.email)}`,
    saml11Attribute('emailaddress', input.email),
    saml11Attribute('givenname', 'WSFed'),
    saml11Attribute('surname', 'User'),
    `</saml:AttributeStatement>`,
    `<saml:AuthenticationStatement AuthenticationMethod="urn:federation:authentication:windows" AuthenticationInstant="${new Date(now - 30_000).toISOString()}">${saml11Subject(input.email)}</saml:AuthenticationStatement>`,
    `</saml:Assertion>`,
  ].join('')
  const doc = Parse(xml)
  const signedXml = new AssertionIdSignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, signer.privateKey, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const signature = signedXml.GetXml()
  if (!signature) throw new Error('fake WS-Fed SAML 1.1 signature not produced')
  doc.documentElement.appendChild(signature)
  return Stringify(doc)
}

// 返回 wresult 的 XML 原文(RequestSecurityTokenResponse)。
export async function buildFakeWresult(input: FakeWsfedTokenInput): Promise<string> {
  const signer = await fakeWsfedSigner()
  const token =
    input.tokenType === 'saml11'
      ? await saml11Assertion(input, signer)
      : await saml2Assertion(input, signer)
  return [
    `<t:RequestSecurityTokenResponse xmlns:t="${WS_TRUST_2005}">`,
    `<t:RequestedSecurityToken>${token}</t:RequestedSecurityToken>`,
    `</t:RequestSecurityTokenResponse>`,
  ].join('')
}
