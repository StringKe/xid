// SAML 2.0 Single Logout:LogoutRequest/LogoutResponse 解析、验签、生成与签名。
// XML-DSig 走 xmldsigjs + Web Crypto,与 Response 验签共用 structure/cert 层。

import { toBufferSource } from '@xid-kit/crypto'
import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { loadIdpVerifyKeys } from './cert'
import type { IdpVerifyKey } from './cert'
import { assertionChild } from './extract'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { decodeBase64Xml, parseSecureXml, SAMLP_NS, SAML_ASSERTION_NS } from './precheck'
import { loadAndCheckSignature, selectSingleSignature } from './structure'

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'

export type VerifiedLogoutRequest = {
  requestId: string
  issuer: string
  destination?: string
  sessionIndex?: string
  nameId?: string
  nameIdFormat?: string
}

export type LogoutResponseInput = {
  issuer: string
  destination: string
  inResponseTo: string
  now?: number
}

export type LogoutRequestInput = {
  issuer: string
  destination: string
  nameId: string
  nameIdFormat: string
  sessionIndex?: string
  now?: number
}

export type SignedLogoutMessage = {
  messageId: string
  xml: string
  samlMessage: string
}

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

function xmlToBase64(xml: string): string {
  const bytes = new TextEncoder().encode(xml)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function inflateRawDeflate(compressed: Uint8Array): Promise<string> {
  const stream = new Blob([toBufferSource(compressed)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new TextDecoder('utf-8', { fatal: true }).decode(
    new Uint8Array(await new Response(stream).arrayBuffer()),
  )
}

async function deflateRawBase64(xml: string): Promise<string> {
  const stream = new Blob([xml]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (const b of compressed) binary += String.fromCharCode(b)
  return btoa(binary)
}

// HTTP-POST:标准 base64;HTTP-Redirect:DEFLATE(raw)+base64。
export async function decodeSamlBindingPayload(
  encoded: string,
  binding: 'post' | 'redirect',
): Promise<SamlResult<string>> {
  if (binding === 'post') return decodeBase64Xml(encoded)
  try {
    const bytes = Uint8Array.from(atob(encoded.trim()), (ch) => ch.charCodeAt(0))
    return okResult(await inflateRawDeflate(bytes))
  } catch (cause) {
    return failResult('malformed_request', `redirect binding decode failed: ${String(cause)}`)
  }
}

async function verifyWithAnyKey(
  signedXml: ReturnType<typeof loadAndCheckSignature>,
  keys: readonly IdpVerifyKey[],
): Promise<boolean> {
  if (!signedXml.ok) return false
  for (const key of keys) {
    try {
      if (await signedXml.value.Verify(key.publicKey)) return true
    } catch {
      // try next key
    }
  }
  return false
}

async function verifySignedRoot(
  doc: Document,
  root: Element,
  keys: readonly IdpVerifyKey[],
): Promise<SamlResult<true>> {
  const selected = selectSingleSignature(root)
  if (!selected.ok) return failResult(selected.error.code, selected.error.reason)
  const loaded = loadAndCheckSignature(doc, selected.value.signature, root)
  if (!loaded.ok) return failResult(loaded.error.code, loaded.error.reason)
  if (!(await verifyWithAnyKey(loaded, keys))) {
    return failResult('signature_invalid', 'no configured key verified LogoutRequest signature')
  }
  return okResult(true)
}

function readLogoutNameId(root: Element): { nameId?: string; nameIdFormat?: string } {
  const nameIdEl = assertionChild(root, SAML_ASSERTION_NS, 'NameID')
  if (!nameIdEl?.textContent) return {}
  return {
    nameId: nameIdEl.textContent.trim(),
    nameIdFormat: nameIdEl.getAttribute('Format') ?? undefined,
  }
}

function readSessionIndex(root: Element): string | undefined {
  const sessionIndex = assertionChild(root, SAML_ASSERTION_NS, 'SessionIndex')
  return sessionIndex?.textContent?.trim() || undefined
}

export type RedirectBindingSignature = {
  samlRequestEncoded: string
  relayState?: string | null
  signature: string
  sigAlg: string
}

export type VerifyLogoutRequestOptions = {
  idpCertificatesB64: readonly string[]
  expectedIssuer: string
  expectedDestination?: string
  redirectSignature?: RedirectBindingSignature
}

export type VerifiedLogoutResponse = {
  responseId: string
  issuer: string
  destination?: string
  inResponseTo: string
  statusCode: string
  sessionIndex?: string
}

export type VerifyLogoutResponseOptions = {
  spCertificatesB64?: readonly string[]
  expectedIssuer?: string
  expectedDestination?: string
  expectedInResponseTo?: string
}

function sigAlgToVerifyParams(sigAlg: string): { name: string; hash: { name: string } } | null {
  switch (sigAlg) {
    case 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256':
      return { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } }
    case 'http://www.w3.org/2000/09/xmldsig#rsa-sha1':
      return { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-1' } }
    default:
      return null
  }
}

export function buildRedirectBindingSignatureString(
  samlParam: string,
  relayState?: string | null,
): string {
  const parts = [`SAMLRequest=${encodeURIComponent(samlParam)}`]
  if (relayState) parts.push(`RelayState=${encodeURIComponent(relayState)}`)
  return parts.join('&')
}

export function buildRedirectBindingResponseSignatureString(
  samlParam: string,
  relayState?: string | null,
): string {
  const parts = [`SAMLResponse=${encodeURIComponent(samlParam)}`]
  if (relayState) parts.push(`RelayState=${encodeURIComponent(relayState)}`)
  return parts.join('&')
}

export async function verifyRedirectBindingSignature(
  signedContent: string,
  signatureB64: string,
  sigAlg: string,
  keys: readonly IdpVerifyKey[],
): Promise<SamlResult<true>> {
  const params = sigAlgToVerifyParams(sigAlg)
  if (!params) return failResult('signature_invalid', 'unsupported SigAlg')
  let sigBytes: Uint8Array
  try {
    sigBytes = Uint8Array.from(atob(signatureB64.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0))
  } catch {
    return failResult('signature_invalid', 'invalid Signature encoding')
  }
  const data = new TextEncoder().encode(signedContent)
  for (const key of keys) {
    try {
      if (await crypto.subtle.verify(params, key.publicKey, toBufferSource(sigBytes), data))
        return okResult(true)
    } catch {
      // try next key
    }
  }
  return failResult('signature_invalid', 'redirect binding signature invalid')
}

export async function verifySamlLogoutRequest(
  logoutRequestXml: string,
  options: VerifyLogoutRequestOptions,
): Promise<SamlResult<VerifiedLogoutRequest>> {
  const parsed = parseSecureXml(logoutRequestXml, 'LogoutRequest')
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const root = parsed.value.documentElement

  const keysResult = await loadIdpVerifyKeys(options.idpCertificatesB64)
  if (!keysResult.ok) return failResult(keysResult.error.code, keysResult.error.reason)

  const embedded = selectSingleSignature(root)
  let signatureVerified = false
  if (embedded.ok) {
    const verified = await verifySignedRoot(parsed.value, root, keysResult.value)
    signatureVerified = verified.ok
  }
  if (!signatureVerified && options.redirectSignature) {
    const signedContent = buildRedirectBindingSignatureString(
      options.redirectSignature.samlRequestEncoded,
      options.redirectSignature.relayState,
    )
    const redirectVerified = await verifyRedirectBindingSignature(
      signedContent,
      options.redirectSignature.signature,
      options.redirectSignature.sigAlg,
      keysResult.value,
    )
    if (!redirectVerified.ok)
      return failResult(redirectVerified.error.code, redirectVerified.error.reason)
    signatureVerified = true
  }
  if (!signatureVerified) {
    return failResult('signature_invalid', 'no configured key verified LogoutRequest signature')
  }

  const requestId = root.getAttribute('ID')
  if (!requestId) return failResult('schema_invalid', 'LogoutRequest ID missing')
  const issuerEl = assertionChild(root, SAML_ASSERTION_NS, 'Issuer')
  const issuer = issuerEl?.textContent?.trim()
  if (!issuer || issuer !== options.expectedIssuer) {
    return failResult('issuer_mismatch', 'LogoutRequest issuer mismatch')
  }
  const destination = root.getAttribute('Destination') ?? undefined
  if (options.expectedDestination) {
    if (!destination) {
      return failResult('recipient_mismatch', 'LogoutRequest destination missing')
    }
    if (destination !== options.expectedDestination) {
      return failResult('recipient_mismatch', 'LogoutRequest destination mismatch')
    }
  }

  const { nameId, nameIdFormat } = readLogoutNameId(root)
  return okResult({
    requestId,
    issuer,
    ...(destination ? { destination } : {}),
    ...(readSessionIndex(root) ? { sessionIndex: readSessionIndex(root) } : {}),
    ...(nameId ? { nameId, nameIdFormat } : {}),
  })
}

export function buildLogoutResponseXml(input: LogoutResponseInput): {
  responseId: string
  xml: string
} {
  const now = input.now ?? Date.now()
  const responseId = samlId('logoutresponse')
  const xml = [
    `<samlp:LogoutResponse xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_ASSERTION_NS}"`,
    ` ID="${responseId}" Version="2.0" IssueInstant="${instant(now)}"`,
    ` Destination="${escapeXml(input.destination)}" InResponseTo="${escapeXml(input.inResponseTo)}">`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${STATUS_SUCCESS}"/></samlp:Status>`,
    `</samlp:LogoutResponse>`,
  ].join('')
  return { responseId, xml }
}

export function buildLogoutRequestXml(input: LogoutRequestInput): {
  requestId: string
  xml: string
} {
  const now = input.now ?? Date.now()
  const requestId = samlId('logoutrequest')
  const sessionIndexEl = input.sessionIndex
    ? `<saml:SessionIndex>${escapeXml(input.sessionIndex)}</saml:SessionIndex>`
    : ''
  const xml = [
    `<samlp:LogoutRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_ASSERTION_NS}"`,
    ` ID="${requestId}" Version="2.0" IssueInstant="${instant(now)}"`,
    ` Destination="${escapeXml(input.destination)}">`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    `<saml:NameID Format="${escapeXml(input.nameIdFormat)}">${escapeXml(input.nameId)}</saml:NameID>`,
    sessionIndexEl,
    `</samlp:LogoutRequest>`,
  ].join('')
  return { requestId, xml }
}

async function signRootElement(
  xml: string,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedLogoutMessage>> {
  try {
    const doc = Parse(xml)
    const root = doc.documentElement
    const id = root.getAttribute('ID') ?? ''
    const signedXml = new SignedXml(doc)
    await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, doc, {
      references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
    })
    const sig = signedXml.GetXml()
    if (!sig) return failResult('signature_invalid', 'logout signature not produced')
    root.appendChild(sig)
    const signed = Stringify(doc)
    return okResult({
      messageId: id,
      xml: signed,
      samlMessage: xmlToBase64(signed),
    })
  } catch (cause) {
    return failResult('signature_invalid', `logout sign failed: ${String(cause)}`)
  }
}

export async function signLogoutResponse(
  input: LogoutResponseInput,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedLogoutMessage>> {
  const built = buildLogoutResponseXml(input)
  return signRootElement(built.xml, privateKey)
}

export async function signLogoutRequest(
  input: LogoutRequestInput,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedLogoutMessage>> {
  const built = buildLogoutRequestXml(input)
  return signRootElement(built.xml, privateKey)
}

export async function encodeRedirectBindingMessage(xml: string): Promise<string> {
  return deflateRawBase64(xml)
}

function readLogoutResponseStatus(root: Element): string | undefined {
  const statusCode = assertionChild(root, SAMLP_NS, 'StatusCode')
  return statusCode?.getAttribute('Value') ?? undefined
}

export async function verifySamlLogoutResponse(
  logoutResponseXml: string,
  options: VerifyLogoutResponseOptions,
): Promise<SamlResult<VerifiedLogoutResponse>> {
  const parsed = parseSecureXml(logoutResponseXml, 'LogoutResponse')
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const root = parsed.value.documentElement

  if (options.spCertificatesB64 && options.spCertificatesB64.length > 0) {
    const keysResult = await loadIdpVerifyKeys(options.spCertificatesB64)
    if (!keysResult.ok) return failResult(keysResult.error.code, keysResult.error.reason)
    const verified = await verifySignedRoot(parsed.value, root, keysResult.value)
    if (!verified.ok) return failResult(verified.error.code, verified.error.reason)
  }

  const responseId = root.getAttribute('ID')
  if (!responseId) return failResult('schema_invalid', 'LogoutResponse ID missing')
  const inResponseTo = root.getAttribute('InResponseTo')
  if (!inResponseTo) return failResult('schema_invalid', 'LogoutResponse InResponseTo missing')
  if (options.expectedInResponseTo && inResponseTo !== options.expectedInResponseTo) {
    return failResult('recipient_mismatch', 'LogoutResponse InResponseTo mismatch')
  }

  const issuerEl = assertionChild(root, SAML_ASSERTION_NS, 'Issuer')
  const issuer = issuerEl?.textContent?.trim()
  if (!issuer) return failResult('schema_invalid', 'LogoutResponse issuer missing')
  if (options.expectedIssuer && issuer !== options.expectedIssuer) {
    return failResult('issuer_mismatch', 'LogoutResponse issuer mismatch')
  }

  const destination = root.getAttribute('Destination') ?? undefined
  if (options.expectedDestination) {
    if (!destination) return failResult('recipient_mismatch', 'LogoutResponse destination missing')
    if (destination !== options.expectedDestination) {
      return failResult('recipient_mismatch', 'LogoutResponse destination mismatch')
    }
  }

  const statusCode = readLogoutResponseStatus(root)
  if (!statusCode) return failResult('schema_invalid', 'LogoutResponse status missing')

  return okResult({
    responseId,
    issuer,
    inResponseTo,
    statusCode,
    ...(destination ? { destination } : {}),
    ...(readSessionIndex(root) ? { sessionIndex: readSessionIndex(root) } : {}),
  })
}

export { POST_BINDING, REDIRECT_BINDING }
