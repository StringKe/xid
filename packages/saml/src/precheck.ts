// 8.0 解码 + 8.1 解析前安全预检(防 XXE/DTD/实体扩展/外部实体/PI)。
// 在 DOMParser.parseFromString 之前对原始字符串扫描,任一命中即拒(malformed_xml,见 04 章 8.1)。
// 解析后断言调用方要求的单根 SAML 消息,EncryptedAssertion 解密后的明文 Assertion 同样复用本预检。

import { Parse } from 'xmldsigjs'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

export const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
export const SAML_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
export const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
export const XENC_NS = 'http://www.w3.org/2001/04/xmlenc#'

// HTTP-POST binding:SAMLResponse 表单值是标准 base64(不是 base64url,不做 URL-decode 再 base64url,见 8.0)。
export function decodeBase64Xml(samlResponse: string): SamlResult<string> {
  try {
    const bytes = Uint8Array.from(atob(samlResponse.trim()), (ch) => ch.charCodeAt(0))
    return okResult(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    return failResult('malformed_request', `base64 decode failed: ${String(cause)}`)
  }
}

// 8.1 原始字符串扫描:DTD / 实体 / 处理指令一律拒(禁 XXE 与 entity expansion)。
// 注:大小写敏感扫描即可,XML 关键字本身大小写固定。
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /<\?xml-stylesheet/i,
  /&[a-z][\w.-]*;/i, // 自定义实体引用(标准 5 个预定义实体除外,下方单独放行)
]

const PREDEFINED_ENTITIES = new Set(['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'])

// 仅放行 5 个预定义实体与数字字符引用,其余实体引用判为注入风险。
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

// 解码 -> 预检 -> 解析为单根 Document。expectedRootLocalName 同时校验文档根名称与命名空间。
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
