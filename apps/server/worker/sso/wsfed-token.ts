// WS-Federation 1.2 第 13 节:wresult 是 wst:RequestSecurityTokenResponse(WS-Trust 1.3 可外包一层
// RequestSecurityTokenResponseCollection),断言放在 RequestedSecurityToken 里。
// 断言以自身为根交给 @xid-kit/saml 验证:SAML 2.0 用 verifySamlAssertion,SAML 1.1 用 verifySaml11Assertion,
// 签名规范化不受 RSTR 信封上的命名空间影响。

import {
  SAML1_ASSERTION_NS,
  securityPrecheck,
  verifySaml11Assertion,
  verifySamlAssertion,
} from '@xid-kit/saml'
import type { AttributeMapping } from '@xid-kit/saml'
import type { SamlAssertionResult } from '@xid-kit/types'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { Element as XmlElement } from '@xmldom/xmldom'
import { AppError } from '../lib/errors'
import { samlErrorToApp } from './saml-errors'

const WS_TRUST_NAMESPACES = new Set([
  'http://schemas.xmlsoap.org/ws/2005/02/trust',
  'http://docs.oasis-open.org/ws-sx/ws-trust/200512',
])
const SAML2_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'

function wresultInvalid(reason: string): AppError {
  return new AppError('malformed_request', { httpStatus: 400, longMessage: `wsfed:${reason}` })
}

function elementChildren(parent: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1) out.push(node as XmlElement)
  }
  return out
}

function trustChild(parent: XmlElement, localName: string): XmlElement | null {
  const matches = elementChildren(parent).filter(
    (child) => child.localName === localName && WS_TRUST_NAMESPACES.has(child.namespaceURI ?? ''),
  )
  if (matches.length > 1) throw wresultInvalid(`multiple_${localName}`)
  return matches[0] ?? null
}

function parseEnvelope(xml: string): XmlElement {
  const pre = securityPrecheck(xml)
  if (!pre.ok) throw wresultInvalid(pre.error.reason)
  let root: XmlElement | null
  try {
    root = new DOMParser().parseFromString(xml, 'text/xml').documentElement
  } catch (cause) {
    throw new AppError('malformed_request', {
      httpStatus: 400,
      longMessage: 'wsfed:malformed_xml',
      cause,
    })
  }
  if (!root || !WS_TRUST_NAMESPACES.has(root.namespaceURI ?? '')) {
    throw wresultInvalid('not_rstr')
  }
  return root
}

function selectRstr(root: XmlElement): XmlElement {
  if (root.localName === 'RequestSecurityTokenResponse') return root
  if (root.localName !== 'RequestSecurityTokenResponseCollection') throw wresultInvalid('not_rstr')
  const rstr = trustChild(root, 'RequestSecurityTokenResponse')
  if (!rstr) throw wresultInvalid('rstr_missing')
  return rstr
}

// 取 RequestedSecurityToken 里唯一的断言元素。
export function extractRequestedToken(xml: string): XmlElement {
  const rstr = selectRstr(parseEnvelope(xml))
  const requested = trustChild(rstr, 'RequestedSecurityToken')
  if (!requested) throw wresultInvalid('requested_security_token_missing')
  const tokens = elementChildren(requested)
  if (tokens.length !== 1 || !tokens[0]) throw wresultInvalid('expected_single_token')
  return tokens[0]
}

export type VerifyWsfedTokenOptions = {
  idpCertificatesB64: readonly string[]
  expectedIssuer: string
  realm: string
  replyUrl: string
  clockSkewToleranceMs: number
  attributeMapping: AttributeMapping
  now?: number
}

// 验证 wresult 中的断言:断言层签名、Issuer、Audience=wtrealm、Conditions 与 SubjectConfirmation 有效期。
// wctx 不进入令牌,由调用方只与服务器端 flow 状态比对,这里不要求 InResponseTo。
export async function verifyWsfedWresult(
  xml: string,
  options: VerifyWsfedTokenOptions,
): Promise<SamlAssertionResult> {
  const token = extractRequestedToken(xml)
  if (token.localName !== 'Assertion') throw wresultInvalid('unsupported_token_type')
  if (token.namespaceURI === SAML1_ASSERTION_NS) return verifySaml11Token(token, options)
  if (token.namespaceURI !== SAML2_ASSERTION_NS) throw wresultInvalid('unsupported_token_type')
  return verifySaml2Token(token, options)
}

async function verifySaml11Token(
  token: XmlElement,
  options: VerifyWsfedTokenOptions,
): Promise<SamlAssertionResult> {
  const verified = await verifySaml11Assertion(new XMLSerializer().serializeToString(token), {
    idpCertificatesB64: options.idpCertificatesB64,
    expectedIssuer: options.expectedIssuer,
    expectedAudience: options.realm,
    clockSkewToleranceMs: options.clockSkewToleranceMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.attributeMapping ? { attributeMapping: options.attributeMapping } : {}),
  })
  if (!verified.ok) throw samlErrorToApp(verified.error.code, verified.error.reason)
  return verified.value
}

// WS-Fed 令牌没有 ACS 概念,AD FS 的 SubjectConfirmationData 常不带 Recipient,所以只在出现时比对。
async function verifySaml2Token(
  token: XmlElement,
  options: VerifyWsfedTokenOptions,
): Promise<SamlAssertionResult> {
  const verified = await verifySamlAssertion(new XMLSerializer().serializeToString(token), {
    idpCertificatesB64: options.idpCertificatesB64,
    expectedIssuer: options.expectedIssuer,
    expectedAudience: options.realm,
    acsUrl: options.replyUrl,
    requireSubjectConfirmationRecipient: false,
    clockSkewToleranceMs: options.clockSkewToleranceMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.attributeMapping ? { attributeMapping: options.attributeMapping } : {}),
  })
  if (!verified.ok) throw samlErrorToApp(verified.error.code, verified.error.reason)
  return verified.value
}
