// AuthnRequest 生成与可选签名。ID 由调用方存 DO 供 InResponseTo 比对;本层只产出原始 XML
// (Redirect 的 DEFLATE 在 worker)。

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
  spEntityId: string
  idpSsoUrl: string
  acsUrl: string
  nameIdFormat?: string
  forceAuthn?: boolean
  now?: number
}

export type GeneratedAuthnRequest = {
  id: string
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
  // xs:ID 必须以字母/下划线开头。
  const rnd = crypto.getRandomValues(new Uint8Array(20))
  let hex = ''
  for (const b of rnd) hex += b.toString(16).padStart(2, '0')
  return `_${hex}`
}

// 插值进 XML 前转义 5 个元字符;& 必须最先替换,避免二次转义。
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

// signAlgorithm 须与 spPrivateKey 匹配(RSASSA-PKCS1-v1_5 或 ECDSA)。
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
