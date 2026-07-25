// SP-initiated AuthnRequest 生成 + 可选 SP 私钥 XML-DSig 签名(见第 1 节证书管理「SP 私钥对 AuthnRequest 签名(可选)」)。
// AuthnRequest ID 由调用方存 DO(一次性,防重放,8.7 step 4 InResponseTo 比对);本层只产出 XML 与 ID。
// HTTP-Redirect binding 下 SAMLRequest 走 DEFLATE+base64;本层产出原始 XML,DEFLATE/编码在 worker 侧(Workers CompressionStream)。

import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { SAMLP_NS, SAML_ASSERTION_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

export type AuthnRequestInput = {
  // 我们(SP)的 EntityID。
  spEntityId: string
  // IdP 的 SSO URL(Destination)。
  idpSsoUrl: string
  // 本 SP ACS URL(AssertionConsumerServiceURL)。
  acsUrl: string
  // 期望 NameID 格式(默认 emailAddress)。
  nameIdFormat?: string
  // 是否要求 IdP 强制重新认证。
  forceAuthn?: boolean
  now?: number
}

export type GeneratedAuthnRequest = {
  // 存 DO 用,回执 InResponseTo 比对(8.7 step 4)。
  id: string
  // 原始 AuthnRequest XML(未 DEFLATE/编码)。
  xml: string
}

const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const DEFAULT_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'

function newRequestId(): string {
  // SAML ID 必须以字母/下划线开头(xs:ID),用 _ 前缀 + 随机 hex。
  const rnd = crypto.getRandomValues(new Uint8Array(20))
  let hex = ''
  for (const b of rnd) hex += b.toString(16).padStart(2, '0')
  return `_${hex}`
}

// XML 转义(防注入):所有插值到 element text / attribute 的值必须经此处理。
// 覆盖 5 个 XML 元字符(& < > " '),& 必须先替换避免二次转义。
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildAuthnRequestXml(id: string, instant: string, input: AuthnRequestInput): string {
  const nameIdFormat = xmlEscape(input.nameIdFormat ?? DEFAULT_NAMEID_FORMAT)
  const forceAuthn = input.forceAuthn ? ' ForceAuthn="true"' : ''
  return [
    `<samlp:AuthnRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_ASSERTION_NS}"`,
    ` ID="${xmlEscape(id)}" Version="2.0" IssueInstant="${xmlEscape(instant)}"`,
    ` Destination="${xmlEscape(input.idpSsoUrl)}" ProtocolBinding="${POST_BINDING}"`,
    ` AssertionConsumerServiceURL="${xmlEscape(input.acsUrl)}"${forceAuthn}>`,
    `<saml:Issuer>${xmlEscape(input.spEntityId)}</saml:Issuer>`,
    `<samlp:NameIDPolicy Format="${nameIdFormat}" AllowCreate="true"/>`,
    `</samlp:AuthnRequest>`,
  ].join('')
}

export function generateAuthnRequest(input: AuthnRequestInput): GeneratedAuthnRequest {
  const id = newRequestId()
  const instant = new Date(input.now ?? Date.now()).toISOString()
  return { id, xml: buildAuthnRequestXml(id, instant, input) }
}

// 可选:用 SP 私钥对 AuthnRequest 做 enveloped + exclusive-c14n XML-DSig 签名(RSA-SHA256/ECDSA-SHA256)。
// signAlgorithm 与 spPrivateKey 必须匹配(RSASSA-PKCS1-v1_5 或 ECDSA)。
export async function signAuthnRequest(
  request: GeneratedAuthnRequest,
  spPrivateKey: CryptoKey,
  signAlgorithm: Algorithm | EcdsaParams,
): Promise<SamlResult<string>> {
  try {
    const doc = Parse(request.xml)
    const signedXml = new SignedXml(doc)
    await signedXml.Sign(signAlgorithm, spPrivateKey, doc, {
      references: [
        { uri: `#${request.id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] },
      ],
    })
    const signatureXml = signedXml.GetXml()
    if (!signatureXml) return failResult('signature_invalid', 'AuthnRequest signature not produced')
    // SAML 要求 Signature 紧跟 Issuer(schema sequence);此处追加到根,IdP 普遍接受 enveloped 位置。
    doc.documentElement.appendChild(signatureXml)
    return okResult(Stringify(doc))
  } catch (cause) {
    return failResult('signature_invalid', `AuthnRequest sign failed: ${String(cause)}`)
  }
}
