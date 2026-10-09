// XID 作为 IdP 时的错误状态 Response(SAML Core 3.2.2.2):不含断言,与 Success Response 一样对 Response 签名。

import { Parse, Stringify } from 'xmldsigjs'
import { SAML_ASSERTION_NS, SAMLP_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { escapeXml, samlId, signElement, xmlToBase64 } from './idp'

const STATUS_PREFIX = 'urn:oasis:names:tc:SAML:2.0:status:'

export const SAML_STATUS = {
  requester: `${STATUS_PREFIX}Requester`,
  responder: `${STATUS_PREFIX}Responder`,
  versionMismatch: `${STATUS_PREFIX}VersionMismatch`,
  noPassive: `${STATUS_PREFIX}NoPassive`,
  invalidNameIdPolicy: `${STATUS_PREFIX}InvalidNameIDPolicy`,
  noAuthnContext: `${STATUS_PREFIX}NoAuthnContext`,
  authnFailed: `${STATUS_PREFIX}AuthnFailed`,
  requestDenied: `${STATUS_PREFIX}RequestDenied`,
} as const

// SAML Core 3.2.2.2:顶层只能是这三个错误码,Success 不走本函数。
const TOP_LEVEL_ERRORS = new Set<string>([
  SAML_STATUS.requester,
  SAML_STATUS.responder,
  SAML_STATUS.versionMismatch,
])

export type SamlStatusResponseInput = {
  issuer: string
  topLevelStatus: string
  secondLevelStatus?: string
  destination?: string
  inResponseTo?: string
  now?: number
}

export type SignedSamlStatusResponse = {
  responseId: string
  xml: string
  samlResponse: string
}

function optionalAttribute(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeXml(value)}"` : ''
}

export function buildSamlStatusResponseXml(input: SamlStatusResponseInput): {
  responseId: string
  xml: string
} {
  const responseId = samlId('response')
  const issuedAt = new Date(input.now ?? Date.now()).toISOString()
  const secondLevel = input.secondLevelStatus
    ? `<samlp:StatusCode Value="${escapeXml(input.secondLevelStatus)}"/>`
    : ''
  const xml = [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_ASSERTION_NS}"`,
    ` ID="${responseId}" Version="2.0" IssueInstant="${issuedAt}"`,
    `${optionalAttribute('Destination', input.destination)}${optionalAttribute('InResponseTo', input.inResponseTo)}>`,
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${escapeXml(input.topLevelStatus)}">${secondLevel}`,
    `</samlp:StatusCode></samlp:Status>`,
    `</samlp:Response>`,
  ].join('')
  return { responseId, xml }
}

export async function signSamlStatusResponse(
  input: SamlStatusResponseInput,
  privateKey: CryptoKey,
): Promise<SamlResult<SignedSamlStatusResponse>> {
  if (!TOP_LEVEL_ERRORS.has(input.topLevelStatus)) {
    return failResult('malformed_request', `top-level status not allowed: ${input.topLevelStatus}`)
  }
  if (input.secondLevelStatus && !input.secondLevelStatus.startsWith(STATUS_PREFIX)) {
    return failResult('malformed_request', 'second-level status must be a SAML status URI')
  }
  try {
    const built = buildSamlStatusResponseXml(input)
    const doc = Parse(built.xml)
    await signElement(doc, doc.documentElement, privateKey)
    const xml = Stringify(doc)
    return okResult({ responseId: built.responseId, xml, samlResponse: xmlToBase64(xml) })
  } catch (cause) {
    return failResult('signature_invalid', `SAML status Response sign failed: ${String(cause)}`)
  }
}
