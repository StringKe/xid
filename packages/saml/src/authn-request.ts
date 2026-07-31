// SP-initiated AuthnRequest 生成 + 可选 SP 私钥 XML-DSig 签名(见第 1 节证书管理「SP 私钥对 AuthnRequest 签名(可选)」)。
// AuthnRequest ID 由调用方存 DO(一次性,防重放,8.7 step 4 InResponseTo 比对);本层只产出 XML 与 ID。
// HTTP-Redirect binding 下 SAMLRequest 走 DEFLATE+base64;本层产出原始 XML,DEFLATE/编码在 worker 侧(Workers CompressionStream)。

import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { loadIdpVerifyKeys } from './cert'
import { assertionChild } from './extract'
import { SAMLP_NS, SAML_ASSERTION_NS } from './precheck'
import { parseSecureXml } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import {
  buildRedirectBindingSignatureString,
  buildWireEncodedRedirectSignatureString,
  verifyRedirectBindingSignature,
} from './logout'
import type { RedirectBindingSignature } from './logout'
import { validateSamlAuthnRequestStructure } from './schema'
import { selectSingleSignature, verifySignedElement } from './structure'

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

export type VerifiedAuthnRequest = {
  requestId: string
  issuer: string
  destination: string
  acsUrl: string
  signatureVerified: boolean
}

export type VerifyAuthnRequestOptions = {
  expectedIssuer: string
  expectedDestination: string
  expectedAcsUrl: string
  spCertificatesB64?: readonly string[]
  requireSignature?: boolean
  redirectSignature?: RedirectBindingSignature
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
    // SAML schema sequence 要求 Signature 紧跟 Issuer。
    const issuer = Array.from({ length: doc.documentElement.childNodes.length }, (_, index) =>
      doc.documentElement.childNodes.item(index),
    ).find(
      (node) =>
        node?.nodeType === 1 &&
        (node as Element).namespaceURI === SAML_ASSERTION_NS &&
        (node as Element).localName === 'Issuer',
    ) as Element | undefined
    doc.documentElement.insertBefore(
      signatureXml,
      issuer?.nextSibling ?? doc.documentElement.firstChild,
    )
    return okResult(Stringify(doc))
  } catch (cause) {
    return failResult('signature_invalid', `AuthnRequest sign failed: ${String(cause)}`)
  }
}

export async function verifySamlAuthnRequest(
  authnRequestXml: string,
  options: VerifyAuthnRequestOptions,
): Promise<SamlResult<VerifiedAuthnRequest>> {
  const parsed = parseSecureXml(authnRequestXml, 'AuthnRequest')
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const root = parsed.value.documentElement
  const structure = validateSamlAuthnRequestStructure(root)
  if (!structure.ok) return failResult(structure.error.code, structure.error.reason)

  const embeddedSignature = selectSingleSignature(root)
  const hasEmbeddedSignature = embeddedSignature.ok
  const hasRedirectSignature = options.redirectSignature !== undefined
  if (options.requireSignature && !hasEmbeddedSignature && !hasRedirectSignature) {
    return failResult('signature_required', 'AuthnRequest signature is required')
  }

  let signatureVerified = false
  if (hasEmbeddedSignature || hasRedirectSignature) {
    const certificates = options.spCertificatesB64 ?? []
    if (certificates.length === 0) {
      return failResult('signature_invalid', 'signed AuthnRequest has no configured SP certificate')
    }
    const keys = await loadIdpVerifyKeys(certificates)
    if (!keys.ok) return failResult(keys.error.code, keys.error.reason)
    if (hasEmbeddedSignature) {
      const verified = await verifySignedElement(parsed.value, root, keys.value)
      if (!verified.ok) return failResult(verified.error.code, verified.error.reason)
      signatureVerified = true
    }
    if (options.redirectSignature) {
      const wireEncoded = options.redirectSignature.wireEncoded
      const signedContent = wireEncoded
        ? buildWireEncodedRedirectSignatureString('SAMLRequest', wireEncoded)
        : buildRedirectBindingSignatureString(
            options.redirectSignature.samlRequestEncoded,
            options.redirectSignature.relayState,
            options.redirectSignature.sigAlg,
          )
      const verified = await verifyRedirectBindingSignature(
        signedContent,
        options.redirectSignature.signature,
        options.redirectSignature.sigAlg,
        keys.value,
      )
      if (!verified.ok) return failResult(verified.error.code, verified.error.reason)
      signatureVerified = true
    }
  }

  const requestId = root.getAttribute('ID') ?? ''
  const issuer = assertionChild(root, SAML_ASSERTION_NS, 'Issuer')?.textContent?.trim() ?? ''
  if (issuer !== options.expectedIssuer) {
    return failResult('issuer_mismatch', 'AuthnRequest issuer mismatch')
  }
  const destination = root.getAttribute('Destination') ?? ''
  if (destination !== options.expectedDestination) {
    return failResult('recipient_mismatch', 'AuthnRequest destination mismatch')
  }
  const acsUrl = root.getAttribute('AssertionConsumerServiceURL') ?? ''
  if (acsUrl !== options.expectedAcsUrl) {
    return failResult('recipient_mismatch', 'AuthnRequest ACS URL mismatch')
  }
  if (root.getAttribute('ProtocolBinding') !== POST_BINDING) {
    return failResult('recipient_mismatch', 'AuthnRequest ProtocolBinding must be HTTP-POST')
  }

  return okResult({ requestId, issuer, destination, acsUrl, signatureVerified })
}
