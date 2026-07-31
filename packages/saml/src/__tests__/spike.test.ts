// SAML-in-Workers 验签可行性 spike(04 章第 7 节标注「架构定稿前必须先做」)。
// 证明 xmldsigjs + @xmldom/xmldom 在 Web Crypto 环境完成 XML-DSig 签名+验签 round-trip。
// 完整端到端验签(解码/预检/结构/语义/解密)见 verify.test.ts。本文件保留最小 round-trip 烟测。

import { describe, it, expect, beforeAll } from 'vitest'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
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

function baseOptions() {
  return {
    idpCertificatesB64: [IDP_CERT_B64],
    expectedIssuer: IDP_ENTITY_ID,
    expectedAudience: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    spInitiated: false,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    now: IDP_CERT_VALID_NOW,
  }
}

describe('SAML XML-DSig spike (xmldsigjs + @xmldom/xmldom + Web Crypto)', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('signs and verifies a SAML Response round-trip (signature valid)', async () => {
    const key = await importIdpSigningKey()
    const signed = await signResponse(buildResponseXml(), key, { response: true, assertion: true })

    const result = await verifySamlResponse(signed, baseOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.issuer).toBe(IDP_ENTITY_ID)
    }
  })

  it('rejects unsigned Response (signature required)', async () => {
    const result = await verifySamlResponse(buildResponseXml(), baseOptions())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })
})
