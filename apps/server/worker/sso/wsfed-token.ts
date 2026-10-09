// WS-Federation 1.2 第 13 节:wresult 是 wst:RequestSecurityTokenResponse(WS-Trust 1.3 可外包一层
// RequestSecurityTokenResponseCollection),断言放在 RequestedSecurityToken 里。
// 断言验签与语义只走 @xid-kit/saml 的公开入口:SAML 2.0 断言包进最小 samlp:Response 交给 verifySamlResponse
// (只要求断言层签名,exc-c14n 与祖先上下文无关);SAML 1.1 断言在内核提供验证入口前一律拒绝。

import { securityPrecheck, verifySamlResponse } from '@xid-kit/saml'
import type { SamlVerifiedAssertion } from '@xid-kit/saml'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { Element as XmlElement } from '@xmldom/xmldom'
import { AppError } from '../lib/errors'
import { samlErrorToApp } from './saml-errors'

const WS_TRUST_NAMESPACES = new Set([
  'http://schemas.xmlsoap.org/ws/2005/02/trust',
  'http://docs.oasis-open.org/ws-sx/ws-trust/200512',
])
const SAML2_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
const SAML11_ASSERTION_NS = 'urn:oasis:names:tc:SAML:1.0:assertion'
const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'

function wresultInvalid(reason: string): AppError {
  return new AppError('signature_invalid', { longMessage: `wsfed:${reason}` })
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
    throw new AppError('signature_invalid', { longMessage: 'wsfed:malformed_xml', cause })
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

function wrapAssertion(assertion: XmlElement, now: number): string {
  const assertionXml = new XMLSerializer().serializeToString(assertion)
  return [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" ID="_wsfed-${crypto.randomUUID()}" Version="2.0"`,
    ` IssueInstant="${new Date(now).toISOString()}">`,
    `<samlp:Status><samlp:StatusCode Value="${STATUS_SUCCESS}"/></samlp:Status>`,
    assertionXml,
    `</samlp:Response>`,
  ].join('')
}

export type VerifyWsfedTokenOptions = {
  idpCertificatesB64: readonly string[]
  expectedIssuer: string
  realm: string
  replyUrl: string
  clockSkewToleranceMs: number
  attributeMapping: Parameters<typeof verifySamlResponse>[1]['attributeMapping']
  now?: number
}

// 验证 wresult 中的断言:断言层签名、Issuer、Audience=wtrealm、Conditions 与 SubjectConfirmation 有效期。
// wctx 不进入令牌,由调用方只与服务器端 flow 状态比对,这里不要求 InResponseTo。
export async function verifyWsfedWresult(
  xml: string,
  options: VerifyWsfedTokenOptions,
): Promise<SamlVerifiedAssertion> {
  const token = extractRequestedToken(xml)
  if (token.namespaceURI === SAML11_ASSERTION_NS) throw wresultInvalid('saml11_unsupported')
  if (token.namespaceURI !== SAML2_ASSERTION_NS || token.localName !== 'Assertion') {
    throw wresultInvalid('unsupported_token_type')
  }
  const now = options.now ?? Date.now()
  const verified = await verifySamlResponse(wrapAssertion(token, now), {
    idpCertificatesB64: options.idpCertificatesB64,
    expectedIssuer: options.expectedIssuer,
    expectedAudience: options.realm,
    acsUrl: options.replyUrl,
    spInitiated: 'auto',
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    clockSkewToleranceMs: options.clockSkewToleranceMs,
    now,
    ...(options.attributeMapping ? { attributeMapping: options.attributeMapping } : {}),
  })
  if (!verified.ok) throw samlErrorToApp(verified.error.code, verified.error.reason)
  return verified.value
}
