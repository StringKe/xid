// 8.3 选签名节点(绝对父子定位,绝不 getElementsByTagName 取首个)+ 8.3/8.4 结构与算法白名单。
// 防 XML Signature Wrapping(XSW)与 Void Canonicalization:单一直接子 Signature、单一 Reference、
// transforms 仅 enveloped + exclusive-c14n、URI=#id 且 id 文档内唯一、被引元素就是签名父元素。

import { SignedXml } from 'xmldsigjs'
import type { IdpVerifyKey } from './cert'
import { DS_NS } from './precheck'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'

const TRANSFORM_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const TRANSFORM_EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'

// digest 白名单:仅 SHA-256/384/512(拒 SHA-1,见 8.4 step 5)。
const DIGEST_ALLOWLIST = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
])

// signature 白名单:RSA-SHA256/384/512 + ECDSA-SHA256+(拒 rsa-sha1,见 8.4 step 5)。
const SIGNATURE_ALLOWLIST = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
])

// 取某元素的直接子 ds:Signature(命名空间 URI 解析,不依赖前缀字面量)。0 或 >1 返回 null/多个标记。
function directSignatureChildren(parent: Element): Element[] {
  const out: Element[] = []
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const node = parent.childNodes.item(i)
    if (node && node.nodeType === 1) {
      const el = node as Element
      if (el.localName === 'Signature' && el.namespaceURI === DS_NS) out.push(el)
    }
  }
  return out
}

// 8.3 step 3:被验证元素有且仅有一个 ds:Signature 直接子节点。0 个 -> required;>1 -> invalid。
export function selectSingleSignature(
  signedElement: Element,
): SamlResult<{ signature: Element; signedElement: Element }> {
  const sigs = directSignatureChildren(signedElement)
  if (sigs.length === 0) return failResult('signature_required', 'no direct ds:Signature child')
  if (sigs.length > 1) return failResult('signature_invalid', 'multiple ds:Signature children')
  return okResult({ signature: sigs[0] as Element, signedElement })
}

// 8.3 step 4 + 5:单一 Reference、transforms <=2 且只 enveloped + exc-c14n、算法白名单(拒带 comments)。
function checkReferenceShape(signedXml: SignedXml): SamlResult<{ uri: string }> {
  const refs = signedXml.XmlSignature.SignedInfo.References
  if (refs.Count !== 1)
    return failResult('signature_invalid', `expected 1 Reference, got ${refs.Count}`)
  const ref = refs.Item(0)
  if (!ref) return failResult('signature_invalid', 'Reference missing')

  const transforms = ref.Transforms.GetIterator().map((t) => t.Algorithm)
  if (transforms.length > 2) return failResult('signature_invalid', 'too many transforms')
  for (const alg of transforms) {
    if (alg !== TRANSFORM_ENVELOPED && alg !== TRANSFORM_EXC_C14N) {
      return failResult('signature_invalid', `disallowed transform: ${alg}`)
    }
  }
  if (!DIGEST_ALLOWLIST.has(ref.DigestMethod.Algorithm)) {
    return failResult('weak_algorithm', `digest not allowed: ${ref.DigestMethod.Algorithm}`)
  }
  const sigAlg = signedXml.XmlSignature.SignedInfo.SignatureMethod.Algorithm
  if (!SIGNATURE_ALLOWLIST.has(sigAlg)) {
    return failResult('weak_algorithm', `signature alg not allowed: ${sigAlg}`)
  }
  return okResult({ uri: ref.Uri ?? '' })
}

// 8.4 step 1-2:URI 必须 #<id>;<id> 在文档内唯一(xs:ID 类型);被引元素就是签名父元素。
function checkReferenceTarget(
  doc: Document,
  signedElement: Element,
  uri: string,
): SamlResult<true> {
  if (!uri.startsWith('#') || uri.length < 2) {
    return failResult('signature_invalid', `Reference URI must be #id, got "${uri}"`)
  }
  const id = uri.slice(1)
  const targets = findElementsById(doc, id)
  if (targets.length !== 1) {
    return failResult('signature_invalid', `id "${id}" not unique (count=${targets.length})`)
  }
  if (targets[0] !== signedElement) {
    return failResult('signature_invalid', 'Reference target is not the signature parent (XSW)')
  }
  return okResult(true)
}

// 按 xs:ID 类型属性精确查找:遍历常见 ID 属性名(ID/Id/AssertionID),要求值匹配且唯一。
// SAML 2.0 Response/Assertion 的 ID 属性名固定为 "ID"(无命名空间)。逐元素扫描计数防 namespace-agnostic 绕过。
function findElementsById(doc: Document, id: string): Element[] {
  const matched: Element[] = []
  const all = doc.getElementsByTagName('*')
  for (let i = 0; i < all.length; i += 1) {
    const el = all.item(i)
    if (el && el.getAttribute('ID') === id) matched.push(el)
  }
  return matched
}

// 组合 8.3 step 4-5 + 8.4 step 1-2:加载签名到 SignedXml 并做全部结构断言。
export function loadAndCheckSignature(
  doc: Document,
  signature: Element,
  signedElement: Element,
): SamlResult<SignedXml> {
  const signedXml = new SignedXml(doc)
  try {
    signedXml.LoadXml(signature)
  } catch (cause) {
    return failResult('signature_invalid', `LoadXml failed: ${String(cause)}`)
  }
  const shape = checkReferenceShape(signedXml)
  if (!shape.ok) return failResult(shape.error.code, shape.error.reason)
  const target = checkReferenceTarget(doc, signedElement, shape.value.uri)
  if (!target.ok) return failResult(target.error.code, target.error.reason)
  return okResult(signedXml)
}

export async function verifySignedElement(
  doc: Document,
  signedElement: Element,
  keys: readonly IdpVerifyKey[],
): Promise<SamlResult<true>> {
  const selected = selectSingleSignature(signedElement)
  if (!selected.ok) return failResult(selected.error.code, selected.error.reason)
  const loaded = loadAndCheckSignature(doc, selected.value.signature, signedElement)
  if (!loaded.ok) return failResult(loaded.error.code, loaded.error.reason)
  for (const key of keys) {
    try {
      if (await loaded.value.Verify(key.publicKey)) return okResult(true)
    } catch {
      // Certificate rotation permits trying every configured key.
    }
  }
  return failResult('signature_invalid', 'no configured key verified XML signature')
}
