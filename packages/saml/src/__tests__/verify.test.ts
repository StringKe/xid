// 端到端 verifySamlResponse 测试:验签成功 + 8.8 各错误分支(签名/语义/解码/预检)。
// 用真实 RSA 证书 + 私钥(fixtures)签 Response/Assertion,真实跑 crypto.subtle 验签。

import { describe, it, expect, beforeAll } from 'vitest'
import { toBufferSource } from '@xid-kit/crypto'
import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import { buildSpMetadataXml } from '../metadata'
import { generateAuthnRequest } from '../authn-request'
import {
  ACS_URL,
  IDP_CERT_B64,
  IDP_ENTITY_ID,
  SP_ENTITY_ID,
  buildResponseXml,
  importIdpSigningKey,
  signResponse,
} from './fixtures'

// 另一把无关 RSA 证书(other.example.com),用于验签失败用例。
const OTHER_CERT_B64 =
  'MIICtDCCAZwCCQDnJfqAQozYiDANBgkqhkiG9w0BAQsFADAcMRowGAYDVQQDDBFvdGhlci5leGFtcGxlLmNvbTAeFw0yNjA2MDEyMDAzNTVaFw0yNzA2MDEyMDAzNTVaMBwxGjAYBgNVBAMMEW90aGVyLmV4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxuiqChBxRbzWh0Q7c7vTy5LocCnauxHVJMb0lAiFabDjnrb+1dLqVXOkfCNnrGHhcgr00JgjeVHNVbBwQVLOHnEKMqwAuxmMbn2kO8eRb6097JAJS3OqF5/g/9e+1PsHa0R/WWvoJT8xZ0XLHv9pxDiftO+yTL1zxidC4Y5bUhLTNO7/ZdyqWQ6i8kOjsyUEbdVSDNSHKOL+Uw4dUKV5n/HHaMFXvc2x8oBlb6xDbXLtl4bkJl8ukePzJSbvZKxVF/kSC6oqB073FunI3n9ZwurHsaCUAj9LOqeyEZBWAXq8+gcyQlbytdcp5c9bbMXZ7ADjt50FZ0jH3+WBJxc8RQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQB4W4hlYrpGhN1W2aY/oHzKbv/e+NR+HoAwmkc1ZFAmEcRrK9i8SJTXm42/BCXpraX4zBfG38Nkdcv617N/pQ1OE+aqsmZk3BopHdNVbBQqYvHpPOl4BVFzBgkhNyM3Y/weCWdTIffCBdZUSTNKDsW7MUqdayS6kQJ6W5TnouJwXOYLm4lheqaS5yoKL5VTkW+w9bvMxcNIMHMA4N24fnaKcNJ6ps0by/BFnxMidJnRw3QMlPDXZ/UAF5zPTDDMku5pp8HpOPvgeh+mRFgp35bMR7VLwvvxi9pOtkBjaB4PZtj6bpQkdmtr1kglxZanuUE67LTz0amLjMOYXiMn5ALF'

const NOW = Date.parse('2026-06-01T08:01:00Z')
const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const XENC_NS = 'http://www.w3.org/2001/04/xmlenc#'
const RSA_OAEP = 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'
const AES256_GCM = 'http://www.w3.org/2009/xmlenc11#aes256-gcm'

function opts(over: Record<string, unknown> = {}) {
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

let signKey: CryptoKey

async function signedResponse(parts = {}, signOpts = { response: true, assertion: true }) {
  return signResponse(buildResponseXml(parts), signKey, signOpts)
}

describe('verifySamlResponse end-to-end', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    signKey = await importIdpSigningKey()
  })

  it('accepts a valid signed Response and maps attributes', async () => {
    const result = await verifySamlResponse(await signedResponse(), opts())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.attributes.email).toBe('user@example.com')
      expect(result.value.attributes.firstName).toBe('Bjorn')
      expect(result.value.attributes.groups).toEqual(['eng', 'admin'])
      expect(result.value.signingCertFingerprint.length).toBeGreaterThan(0)
    }
  })

  it('signature_required when wantAssertionsSigned but assertion unsigned', async () => {
    const xml = await signedResponse({}, { response: true, assertion: false })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('signature_invalid when verified with an unrelated cert', async () => {
    // 用 IdP 私钥签,但 connection 配置一把无关证书(other.example.com)-> 公钥不匹配,验签失败。
    const xml = await signedResponse()
    const result = await verifySamlResponse(xml, opts({ idpCertificatesB64: [OTHER_CERT_B64] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('issuer_mismatch when Issuer differs from config', async () => {
    const xml = await signedResponse({ issuer: 'https://evil.example.com' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('issuer_mismatch')
  })

  it('assertion_expired when NotOnOrAfter passed', async () => {
    const xml = await signedResponse({ notOnOrAfter: '2026-06-01T07:00:00Z' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('assertion_expired')
  })

  it('recipient_mismatch when Recipient != ACS', async () => {
    const xml = await signedResponse({ recipient: 'https://acme.xid.dev/wrong/acs' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('recipient_mismatch when Response Destination != ACS', async () => {
    const xml = await signedResponse({ destination: 'https://acme.xid.dev/wrong/acs' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('recipient_mismatch when SubjectConfirmation Method is not bearer', async () => {
    const xml = await signedResponse({
      subjectConfirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
    })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })
})

describe('verifySamlResponse status / precheck / InResponseTo', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    signKey = await importIdpSigningKey()
  })

  it('audience_mismatch when AudienceRestriction excludes SP', async () => {
    const xml = await signedResponse({ audience: 'https://other.sp/saml' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('audience_mismatch')
  })

  it('idp_status_error when StatusCode != Success', async () => {
    const xml = await signedResponse({ status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('idp_status_error')
      expect(result.error.idpStatus).toContain('Requester')
    }
  })

  it('malformed_xml when DTD present (XXE precheck)', async () => {
    const xml = '<!DOCTYPE x><samlp:Response/>'
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_xml')
  })
})

describe('verifySamlResponse SP-initiated InResponseTo', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    signKey = await importIdpSigningKey()
  })

  it('SP-initiated requires InResponseTo present', async () => {
    const xml = await signedResponse()
    const result = await verifySamlResponse(xml, opts({ spInitiated: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('SP-initiated accepts matching InResponseTo', async () => {
    const xml = await signedResponse({ inResponseTo: '_req_123' })
    const result = await verifySamlResponse(xml, opts({ spInitiated: true }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.inResponseTo).toBe('_req_123')
  })

  it('auto mode accepts IdP and SP initiated assertions', async () => {
    const idpXml = await signedResponse()
    const spXml = await signedResponse({ inResponseTo: '_req_456' })

    const idpResult = await verifySamlResponse(idpXml, opts({ spInitiated: 'auto' }))
    const spResult = await verifySamlResponse(spXml, opts({ spInitiated: 'auto' }))

    expect(idpResult.ok).toBe(true)
    expect(spResult.ok).toBe(true)
    if (spResult.ok) expect(spResult.value.inResponseTo).toBe('_req_456')
  })
})

// 提取签名后 Response 中第一个 <saml:Assertion>...</saml:Assertion> 完整片段(含其 enveloped Signature)。
function extractSignedAssertion(responseXml: string): string {
  const start = responseXml.indexOf('<saml:Assertion ')
  const end = responseXml.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length
  return responseXml.slice(start, end)
}

// 在 Response 的 Status 之后、原 Assertion 之前注入一段片段(模拟 XSW 包装位置)。
function injectBeforeAssertion(responseXml: string, fragment: string): string {
  const at = responseXml.indexOf('<saml:Assertion ')
  return responseXml.slice(0, at) + fragment + responseXml.slice(at)
}

function b64(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out)
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function standaloneAssertion(assertionXml: string): string {
  if (assertionXml.includes('xmlns:saml=')) return assertionXml
  return assertionXml.replace('<saml:Assertion ', `<saml:Assertion xmlns:saml="${ASSERT_NS}" `)
}

async function generateSpDecryptKeyPair(): Promise<CryptoKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  )
  if ('publicKey' in keyPair) return keyPair
  throw new Error('expected RSA-OAEP key pair')
}

async function encryptedAssertionResponse(
  assertionXml: string,
  spPublicKey: CryptoKey,
): Promise<string> {
  const sessionKeyRaw = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(sessionKeyRaw),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const encryptedAssertion = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv) },
      aesKey,
      new TextEncoder().encode(assertionXml),
    ),
  )
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, spPublicKey, toBufferSource(sessionKeyRaw)),
  )
  const cipherValue = b64(concatBytes(iv, encryptedAssertion))
  const keyCipherValue = b64(wrappedKey)
  return [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${ASSERT_NS}" xmlns:xenc="${XENC_NS}" xmlns:ds="${DS_NS}"`,
    ` ID="_resp_encrypted" Version="2.0" IssueInstant="2026-06-01T08:00:00Z" Destination="${ACS_URL}">`,
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`,
    `<saml:EncryptedAssertion><xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Element">`,
    `<xenc:EncryptionMethod Algorithm="${AES256_GCM}"/>`,
    `<ds:KeyInfo><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="${RSA_OAEP}"/>`,
    `<xenc:CipherData><xenc:CipherValue>${keyCipherValue}</xenc:CipherValue></xenc:CipherData>`,
    `</xenc:EncryptedKey></ds:KeyInfo>`,
    `<xenc:CipherData><xenc:CipherValue>${cipherValue}</xenc:CipherValue></xenc:CipherData>`,
    `</xenc:EncryptedData></saml:EncryptedAssertion></samlp:Response>`,
  ].join('')
}

async function signStandaloneAssertion(assertionXml: string, key: CryptoKey): Promise<string> {
  const doc = Parse(assertionXml)
  const id = doc.documentElement.getAttribute('ID') ?? ''
  const signedXml = new SignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, key, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const sig = signedXml.GetXml()
  if (!sig) throw new Error('signature not produced')
  doc.documentElement.appendChild(sig)
  return Stringify(doc)
}

// 伪造一个未签名 Assertion(攻击者 NameID),用于注入测试。
function forgedAssertion(id: string, email: string): string {
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

// XSW(XML Signature Wrapping)负测试:签名节点移位 / 重复 Assertion / 引用目标偏移,verify 必须拒绝。
describe('verifySamlResponse XSW (signature wrapping) defense', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    signKey = await importIdpSigningKey()
  })

  // 仅签 Assertion 的配置(把 XSW 焦点放在 Assertion 层包装)。
  function assertionOnly(over: Record<string, unknown> = {}) {
    return opts({ wantAuthnResponseSigned: false, wantAssertionsSigned: true, ...over })
  }

  it('rejects duplicated signed Assertion (cloned ID -> id not unique)', async () => {
    // 复制整段已签名 Assertion(同 ID),Reference 目标在文档内出现两次 -> 拒。
    const signed = await signedResponse({}, { response: false, assertion: true })
    const clone = extractSignedAssertion(signed)
    const tampered = injectBeforeAssertion(signed, clone)
    const result = await verifySamlResponse(tampered, assertionOnly())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('rejects forged unsigned Assertion injected before the signed one (signature_required)', async () => {
    // 在已签名 Assertion 前注入伪造未签名 Assertion(攻击者 email)。
    // 被消费的是首个 Assertion(伪造,无直接 Signature 子节点)-> signature_required。
    const signed = await signedResponse({}, { response: false, assertion: true })
    const evil = forgedAssertion('_evil_assert', 'attacker@evil.example.com')
    const tampered = injectBeforeAssertion(signed, evil)
    const result = await verifySamlResponse(tampered, assertionOnly())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('rejects when both want-signed flags are false (baseline forces assertion signature)', async () => {
    // 双 false 配置:实现回退到强制 assertion 签名,未签名 Response 被拒(P2 修复)。
    const unsigned = buildResponseXml()
    const result = await verifySamlResponse(
      unsigned,
      opts({ wantAuthnResponseSigned: false, wantAssertionsSigned: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })
})

describe('verifySamlResponse EncryptedAssertion', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    signKey = await importIdpSigningKey()
  })

  async function encryptedSignedResponse() {
    const spKeyPair = await generateSpDecryptKeyPair()
    const unsigned = standaloneAssertion(extractSignedAssertion(buildResponseXml()))
    const assertion = await signStandaloneAssertion(unsigned, signKey)
    const xml = await encryptedAssertionResponse(assertion, spKeyPair.publicKey)
    return { xml, privateKey: spKeyPair.privateKey }
  }

  it('accepts a signed encrypted Assertion after decrypt-then-verify', async () => {
    const { xml, privateKey } = await encryptedSignedResponse()
    const result = await verifySamlResponse(
      xml,
      opts({
        wantAuthnResponseSigned: false,
        wantAssertionsSigned: true,
        spDecryptKey: privateKey,
      }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.attributes.groups).toEqual(['eng', 'admin'])
      expect(result.value.signingCertFingerprint.length).toBeGreaterThan(0)
    }
  })

  it('decryption_failed when encrypted Assertion has no SP decrypt key', async () => {
    const { xml } = await encryptedSignedResponse()
    const result = await verifySamlResponse(
      xml,
      opts({ wantAuthnResponseSigned: false, wantAssertionsSigned: true }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('decryption_failed when encrypted Assertion uses a disallowed data algorithm', async () => {
    const { xml, privateKey } = await encryptedSignedResponse()
    const tampered = xml.replace(AES256_GCM, 'http://www.w3.org/2001/04/xmlenc#tripledes-cbc')
    const result = await verifySamlResponse(
      tampered,
      opts({
        wantAuthnResponseSigned: false,
        wantAssertionsSigned: true,
        spDecryptKey: privateKey,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('signature_required when decrypted Assertion is unsigned', async () => {
    const spKeyPair = await generateSpDecryptKeyPair()
    const unsignedAssertion = standaloneAssertion(extractSignedAssertion(buildResponseXml()))
    const xml = await encryptedAssertionResponse(unsignedAssertion, spKeyPair.publicKey)
    const result = await verifySamlResponse(
      xml,
      opts({
        wantAuthnResponseSigned: false,
        wantAssertionsSigned: true,
        spDecryptKey: spKeyPair.privateKey,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })
})

describe('SP metadata + AuthnRequest', () => {
  it('builds SP metadata with required fields', () => {
    const xml = buildSpMetadataXml({
      entityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      authnRequestsSigned: false,
      wantAssertionsSigned: true,
      signingCertsB64: [IDP_CERT_B64],
      encryptionCertsB64: [IDP_CERT_B64],
    })
    expect(xml).toContain(`entityID="${SP_ENTITY_ID}"`)
    expect(xml).toContain('WantAssertionsSigned="true"')
    expect(xml).toContain('AssertionConsumerService')
    expect(xml).toContain('use="encryption"')
    expect(xml).toContain('nameid-format:emailAddress')
  })

  it('generates AuthnRequest with id + Destination', () => {
    const req = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: 'https://idp.example.com/sso',
      acsUrl: ACS_URL,
    })
    expect(req.id.startsWith('_')).toBe(true)
    expect(req.xml).toContain('Destination="https://idp.example.com/sso"')
    expect(req.xml).toContain(`<saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`)
  })
})
