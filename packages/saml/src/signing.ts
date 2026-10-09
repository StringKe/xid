// XID 发出的 XML 签名统一用 exclusive C14N 规范化 SignedInfo。xmldsigjs 默认 inclusive C14N,
// 其输出包含祖先作用域的命名空间,签名元素换到另一个外壳里就会验签失败;SAML 各家 IdP/SP 也都用 exclusive C14N。

import { SignedXml } from 'xmldsigjs'

export const EXCLUSIVE_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'

export function createSamlSignedXml(doc: Document): SignedXml {
  const signedXml = new SignedXml(doc)
  signedXml.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm = EXCLUSIVE_C14N
  return signedXml
}
