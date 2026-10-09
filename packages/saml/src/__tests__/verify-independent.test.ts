// 独立实现签名的回归样本:samples/independent-signatures.json 由 xml-crypto 6.3.3 用一张百年有效期的
// 测试证书离线签好(SignedInfo 与 Reference 均为 exclusive C14N,另有一份 inclusive C14N),不依赖 xmldsigjs 的签名上下文。

import { beforeAll, describe, expect, it } from 'vitest'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import samples from './samples/independent-signatures.json'

const NOW = Date.parse('2026-10-10T00:05:00Z')
const SAMLP = 'urn:oasis:names:tc:SAML:2.0:protocol'
const ISSUER = 'https://independent-idp.example.com/metadata'
const AUDIENCE = 'https://acme.xid.dev/saml/conn_1'
const ACS = 'https://acme.xid.dev/sso/saml/conn_1/acs'

function options(over: Record<string, unknown> = {}) {
  return {
    idpCertificatesB64: [samples.certificateB64],
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
    acsUrl: ACS,
    spInitiated: false,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    now: NOW,
    ...over,
  }
}

// 外层 Response 声明自己的 samlp 前缀,断言原样嵌入,模拟 IdP 先签断言再装进 Response。
function embedInResponse(signedAssertion: string): string {
  return [
    `<samlp:Response xmlns:samlp="${SAMLP}" ID="_outer" Version="2.0" IssueInstant="2026-10-10T00:00:00Z" Destination="${ACS}">`,
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`,
    signedAssertion.replace(/^<\?xml[^>]*\?>/, ''),
    `</samlp:Response>`,
  ].join('')
}

describe('verifySamlResponse with independently signed samples', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it.each([
    ['a prefixed assertion signed on its own', samples.prefixedAssertionSignedStandalone],
    [
      'a default-namespace assertion signed on its own',
      samples.defaultNamespaceAssertionSignedStandalone,
    ],
  ])('accepts %s and then embedded in a Response', async (_label, signedAssertion) => {
    const result = await verifySamlResponse(embedInResponse(signedAssertion), options())

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.subject.nameId).toBe('user@example.com')
  })

  it('accepts a default-namespace assertion signed in place inside the Response (AD FS style)', async () => {
    const result = await verifySamlResponse(
      samples.defaultNamespaceAssertionSignedInResponse,
      options(),
    )

    expect(result.ok).toBe(true)
  })

  it('accepts a Response-level signature over a prefixed assertion', async () => {
    const result = await verifySamlResponse(
      samples.responseSignedPrefixedAssertion,
      options({ wantAuthnResponseSigned: true, wantAssertionsSigned: false }),
    )

    expect(result.ok).toBe(true)
  })

  it('accepts an assertion whose SignedInfo uses inclusive C14N when verified in its signing context', async () => {
    const result = await verifySamlResponse(
      samples.inclusiveSignedInfoAssertionInResponse,
      options(),
    )

    expect(result.ok).toBe(true)
  })

  it('signature_invalid when an embedded independently signed assertion is tampered', async () => {
    const tampered = embedInResponse(samples.prefixedAssertionSignedStandalone).replace(
      '>user@example.com</saml:NameID>',
      '>attacker@evil.example.com</saml:NameID>',
    )

    const result = await verifySamlResponse(tampered, options())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('signature_invalid when the Response-level signed assertion is tampered', async () => {
    const tampered = samples.responseSignedPrefixedAssertion.replace(
      '>user@example.com</saml:NameID>',
      '>attacker@evil.example.com</saml:NameID>',
    )

    const result = await verifySamlResponse(
      tampered,
      options({ wantAuthnResponseSigned: true, wantAssertionsSigned: false }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })
})
