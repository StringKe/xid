// 解码与解析前预检:禁 XXE/DTD/实体扩展/PI;解密后明文 Assertion 同样复用。

import { Parse } from 'xmldsigjs'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

export const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
export const SAML_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
export const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
export const XENC_NS = 'http://www.w3.org/2001/04/xmlenc#'

// HTTP-POST 表单值为标准 base64,不是 base64url。
export function decodeBase64Xml(samlResponse: string): SamlResult<string> {
  try {
    const bytes = Uint8Array.from(atob(samlResponse.trim()), (ch) => ch.charCodeAt(0))
    return okResult(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    return failResult('malformed_request', `base64 decode failed: ${String(cause)}`)
  }
}

// XML 关键字大小写固定,敏感扫描即可。
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /<\?xml-stylesheet/i,
  /&[a-z][\w.-]*;/i, // 自定义实体引用(标准 5 个预定义实体除外,下方单独放行)
]

const PREDEFINED_ENTITIES = new Set(['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'])

// 仅放行 5 个预定义实体与数字字符引用。
function hasUnsafeEntity(xml: string): boolean {
  const matches = xml.match(/&[#a-zA-Z][\w.-]*;/g)
  if (!matches) return false
  for (const m of matches) {
    if (PREDEFINED_ENTITIES.has(m)) continue
    if (/^&#(\d+|x[0-9a-fA-F]+);$/.test(m)) continue
    return true
  }
  return false
}

export function securityPrecheck(xml: string): SamlResult<true> {
  for (const pat of DANGEROUS_PATTERNS.slice(0, 3)) {
    if (pat.test(xml)) return failResult('malformed_xml', `forbidden construct: ${pat.source}`)
  }
  if (hasUnsafeEntity(xml)) return failResult('malformed_xml', 'forbidden entity reference')
  return okResult(true)
}

export function parseSecureXml(xml: string, expectedRootLocalName: string): SamlResult<Document> {
  const pre = securityPrecheck(xml)
  if (!pre.ok) return failResult(pre.error.code, pre.error.reason)

  let doc: Document
  try {
    doc = Parse(xml)
  } catch (cause) {
    return failResult('malformed_xml', `parse failed: ${String(cause)}`)
  }

  const root = doc.documentElement
  if (!root || root.localName !== expectedRootLocalName) {
    return failResult('malformed_xml', `expected root <${expectedRootLocalName}>`)
  }
  const protocolRoots = new Set(['Response', 'AuthnRequest', 'LogoutRequest', 'LogoutResponse'])
  const expectedNs = protocolRoots.has(expectedRootLocalName) ? SAMLP_NS : SAML_ASSERTION_NS
  if (root.namespaceURI !== expectedNs) {
    return failResult('malformed_xml', `root namespace mismatch for <${expectedRootLocalName}>`)
  }
  return okResult(doc)
}
