// LogoutRequest/Response 解析、验签与签名;与 Response 共用 structure/cert。

import { toBufferSource } from '@xid-kit/crypto'
import { Parse, SignedXml, Stringify } from 'xmldsigjs'
import { DEFAULT_SAML_CLOCK_SKEW_MS, loadIdpVerifyKeys, MAX_SAML_CLOCK_SKEW_MS } from './cert'
import type { IdpVerifyKey } from './cert'
import { assertionChild } from './extract'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { parseSamlInstant } from './instant'
import { decodeBase64Xml, parseSecureXml, SAMLP_NS, SAML_ASSERTION_NS } from './precheck'
import { validateSamlLogoutRequestStructure, validateSamlLogoutResponseStructure } from './schema'
import { selectSingleSignature, verifySignedElement } from './structure'

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
export const REDIRECT_BINDING_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const MAX_REDIRECT_BINDING_DECOMPRESSED_BYTES = 256 * 1024
const LOGOUT_REQUEST_MAX_AGE_MS = 5 * 60 * 1000

export type VerifiedLogoutRequest = {
  requestId: string
  issuer: string
  validUntil: number
  destination?: string
  sessionIndexes: string[]
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
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_REDIRECT_BINDING_DECOMPRESSED_BYTES) {
        await reader.cancel('SAML Redirect payload exceeds decompressed size limit')
        throw new Error('SAML Redirect payload exceeds 256 KiB decompressed limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(output)
}

async function deflateRawBase64(xml: string): Promise<string> {
  const stream = new Blob([xml]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (const b of compressed) binary += String.fromCharCode(b)
  return btoa(binary)
}

// POST 为标准 base64;Redirect 为 DEFLATE(raw)+base64。
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

function readLogoutNameId(root: Element): { nameId?: string; nameIdFormat?: string } {
  const nameIdEl = assertionChild(root, SAML_ASSERTION_NS, 'NameID')
  if (!nameIdEl?.textContent) return {}
  return {
    nameId: nameIdEl.textContent.trim(),
    nameIdFormat: nameIdEl.getAttribute('Format') ?? undefined,
  }
}

function readSessionIndexes(root: Element): string[] {
  const sessionIndexes: string[] = []
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const node = root.childNodes.item(index)
    if (
      node?.nodeType === 1 &&
      (node as Element).namespaceURI === SAMLP_NS &&
      (node as Element).localName === 'SessionIndex'
    ) {
      const value = node.textContent?.trim()
      if (value) sessionIndexes.push(value)
    }
  }
  return sessionIndexes
}

function readSessionIndex(root: Element): string | undefined {
  return readSessionIndexes(root)[0]
}

export type RedirectBindingSignature = {
  samlRequestEncoded: string
  relayState?: string | null
  signature: string
  sigAlg: string
  wireEncoded?: WireEncodedRedirectSignatureInput
}

export type RedirectBindingResponseSignature = {
  samlResponseEncoded: string
  relayState?: string | null
  signature: string
  sigAlg: string
  wireEncoded?: WireEncodedRedirectSignatureInput
}

export type WireEncodedRedirectSignatureInput = {
  samlMessage: string
  relayState?: string | null
  sigAlg: string
}

export type SignedRedirectBinding = {
  sigAlg: typeof REDIRECT_BINDING_RSA_SHA256
  signature: string
  query: string
}

export type VerifyLogoutRequestOptions = {
  idpCertificatesB64: readonly string[]
  expectedIssuer: string
  expectedDestination?: string
  redirectSignature?: RedirectBindingSignature
  now?: number
  clockSkewToleranceMs?: number
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
  redirectSignature?: RedirectBindingResponseSignature
  requireSignature?: boolean
  now?: number
  clockSkewToleranceMs?: number
}

function sigAlgToVerifyParams(sigAlg: string): { name: string; hash: { name: string } } | null {
  if (sigAlg !== REDIRECT_BINDING_RSA_SHA256) return null
  return { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } }
}

export function buildRedirectBindingSignatureString(
  samlParam: string,
  relayState?: string | null,
  sigAlg: string = REDIRECT_BINDING_RSA_SHA256,
): string {
  const parts = [`SAMLRequest=${encodeURIComponent(samlParam)}`]
  if (relayState !== undefined && relayState !== null) {
    parts.push(`RelayState=${encodeURIComponent(relayState)}`)
  }
  parts.push(`SigAlg=${encodeURIComponent(sigAlg)}`)
  return parts.join('&')
}

export function buildRedirectBindingResponseSignatureString(
  samlParam: string,
  relayState?: string | null,
  sigAlg: string = REDIRECT_BINDING_RSA_SHA256,
): string {
  const parts = [`SAMLResponse=${encodeURIComponent(samlParam)}`]
  if (relayState !== undefined && relayState !== null) {
    parts.push(`RelayState=${encodeURIComponent(relayState)}`)
  }
  parts.push(`SigAlg=${encodeURIComponent(sigAlg)}`)
  return parts.join('&')
}

export function buildWireEncodedRedirectSignatureString(
  messageName: 'SAMLRequest' | 'SAMLResponse',
  input: WireEncodedRedirectSignatureInput,
): string {
  const parts = [`${messageName}=${input.samlMessage}`]
  if (input.relayState !== undefined && input.relayState !== null) {
    parts.push(`RelayState=${input.relayState}`)
  }
  parts.push(`SigAlg=${input.sigAlg}`)
  return parts.join('&')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function signRedirectBindingContent(
  signedContent: string,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedRedirectBinding>> {
  try {
    const signature = bytesToBase64(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'RSASSA-PKCS1-v1_5' },
          privateKey,
          new TextEncoder().encode(signedContent),
        ),
      ),
    )
    return okResult({
      sigAlg: REDIRECT_BINDING_RSA_SHA256,
      signature,
      query: `${signedContent}&Signature=${encodeURIComponent(signature)}`,
    })
  } catch (cause) {
    return failResult('signature_invalid', `redirect binding sign failed: ${String(cause)}`)
  }
}

export function signRedirectBindingRequest(
  samlRequestEncoded: string,
  relayState: string | null | undefined,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedRedirectBinding>> {
  return signRedirectBindingContent(
    buildRedirectBindingSignatureString(
      samlRequestEncoded,
      relayState,
      REDIRECT_BINDING_RSA_SHA256,
    ),
    privateKey,
  )
}

export function signRedirectBindingResponse(
  samlResponseEncoded: string,
  relayState: string | null | undefined,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedRedirectBinding>> {
  return signRedirectBindingContent(
    buildRedirectBindingResponseSignatureString(
      samlResponseEncoded,
      relayState,
      REDIRECT_BINDING_RSA_SHA256,
    ),
    privateKey,
  )
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
      // 证书轮换:单把失败继续试下一把。
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
  const structure = validateSamlLogoutRequestStructure(root)
  if (!structure.ok) return failResult(structure.error.code, structure.error.reason)

  const keysResult = await loadIdpVerifyKeys(options.idpCertificatesB64, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.clockSkewToleranceMs !== undefined
      ? { toleranceMs: options.clockSkewToleranceMs }
      : {}),
  })
  if (!keysResult.ok) return failResult(keysResult.error.code, keysResult.error.reason)

  const embedded = selectSingleSignature(root)
  if (embedded.ok) {
    const verified = await verifySignedElement(parsed.value, root, keysResult.value)
    if (!verified.ok) return failResult(verified.error.code, verified.error.reason)
  }
  if (options.redirectSignature) {
    const signedContent = options.redirectSignature.wireEncoded
      ? buildWireEncodedRedirectSignatureString(
          'SAMLRequest',
          options.redirectSignature.wireEncoded,
        )
      : buildRedirectBindingSignatureString(
          options.redirectSignature.samlRequestEncoded,
          options.redirectSignature.relayState,
          options.redirectSignature.sigAlg,
        )
    const redirectVerified = await verifyRedirectBindingSignature(
      signedContent,
      options.redirectSignature.signature,
      options.redirectSignature.sigAlg,
      keysResult.value,
    )
    if (!redirectVerified.ok)
      return failResult(redirectVerified.error.code, redirectVerified.error.reason)
  }
  if (!embedded.ok && !options.redirectSignature) {
    return failResult('signature_invalid', 'no configured key verified LogoutRequest signature')
  }

  const now = options.now ?? Date.now()
  const clockSkewToleranceMs = options.clockSkewToleranceMs ?? DEFAULT_SAML_CLOCK_SKEW_MS
  if (!Number.isFinite(now)) {
    return failResult('assertion_expired', 'invalid LogoutRequest check time')
  }
  if (
    !Number.isSafeInteger(clockSkewToleranceMs) ||
    clockSkewToleranceMs < 0 ||
    clockSkewToleranceMs > MAX_SAML_CLOCK_SKEW_MS
  ) {
    return failResult('assertion_expired', 'invalid LogoutRequest clock tolerance')
  }
  const issueInstant = parseSamlInstant(root.getAttribute('IssueInstant'))
  if (issueInstant === null) {
    return failResult('assertion_expired', 'LogoutRequest IssueInstant invalid')
  }
  if (issueInstant > now + clockSkewToleranceMs) {
    return failResult('assertion_expired', 'LogoutRequest IssueInstant in future')
  }
  const freshnessDeadline = issueInstant + LOGOUT_REQUEST_MAX_AGE_MS
  const declaredNotOnOrAfter = root.hasAttribute('NotOnOrAfter')
    ? parseSamlInstant(root.getAttribute('NotOnOrAfter'))
    : null
  if (root.hasAttribute('NotOnOrAfter') && declaredNotOnOrAfter === null) {
    return failResult('assertion_expired', 'LogoutRequest NotOnOrAfter invalid')
  }
  if (declaredNotOnOrAfter !== null && declaredNotOnOrAfter <= issueInstant) {
    return failResult('assertion_expired', 'LogoutRequest validity interval is invalid')
  }
  const validUntil =
    declaredNotOnOrAfter === null
      ? freshnessDeadline
      : Math.min(freshnessDeadline, declaredNotOnOrAfter)
  if (now >= validUntil) {
    return failResult('assertion_expired', 'LogoutRequest has expired')
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
    validUntil,
    sessionIndexes: readSessionIndexes(root),
    ...(destination ? { destination } : {}),
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
    ? `<samlp:SessionIndex>${escapeXml(input.sessionIndex)}</samlp:SessionIndex>`
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
    const issuer = assertionChild(root, SAML_ASSERTION_NS, 'Issuer')
    root.insertBefore(sig, issuer?.nextSibling ?? root.firstChild)
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
  const status = assertionChild(root, SAMLP_NS, 'Status')
  const statusCode = status ? assertionChild(status, SAMLP_NS, 'StatusCode') : null
  return statusCode?.getAttribute('Value') ?? undefined
}

export async function verifySamlLogoutResponse(
  logoutResponseXml: string,
  options: VerifyLogoutResponseOptions,
): Promise<SamlResult<VerifiedLogoutResponse>> {
  const parsed = parseSecureXml(logoutResponseXml, 'LogoutResponse')
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const root = parsed.value.documentElement
  const structure = validateSamlLogoutResponseStructure(root)
  if (!structure.ok) return failResult(structure.error.code, structure.error.reason)

  const embeddedSignature = selectSingleSignature(root)
  const hasEmbeddedSignature = embeddedSignature.ok
  const hasRedirectSignature = options.redirectSignature !== undefined
  if (options.requireSignature && !hasEmbeddedSignature && !hasRedirectSignature) {
    return failResult('signature_required', 'LogoutResponse signature is required')
  }

  if (hasEmbeddedSignature || hasRedirectSignature) {
    const certificates = options.spCertificatesB64 ?? []
    if (certificates.length === 0) {
      return failResult('signature_invalid', 'signed LogoutResponse has no configured certificate')
    }
    const keysResult = await loadIdpVerifyKeys(certificates, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.clockSkewToleranceMs !== undefined
        ? { toleranceMs: options.clockSkewToleranceMs }
        : {}),
    })
    if (!keysResult.ok) return failResult(keysResult.error.code, keysResult.error.reason)
    if (hasEmbeddedSignature) {
      const verified = await verifySignedElement(parsed.value, root, keysResult.value)
      if (!verified.ok) return failResult(verified.error.code, verified.error.reason)
    }
    if (options.redirectSignature) {
      const signedContent = options.redirectSignature.wireEncoded
        ? buildWireEncodedRedirectSignatureString(
            'SAMLResponse',
            options.redirectSignature.wireEncoded,
          )
        : buildRedirectBindingResponseSignatureString(
            options.redirectSignature.samlResponseEncoded,
            options.redirectSignature.relayState,
            options.redirectSignature.sigAlg,
          )
      const verified = await verifyRedirectBindingSignature(
        signedContent,
        options.redirectSignature.signature,
        options.redirectSignature.sigAlg,
        keysResult.value,
      )
      if (!verified.ok) return failResult(verified.error.code, verified.error.reason)
    }
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
