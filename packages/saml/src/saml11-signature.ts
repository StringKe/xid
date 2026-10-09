// SAML 1.1 断言验签。xmldsigjs 只按 Id/ID/id 解析 Reference URI,不认 SAML 1.1 的 AssertionID。
// 结构层已确认唯一 Reference 的 URI 指向 AssertionID 唯一且等于签名父元素(即文档根),
// 因此摘要直接对根元素计算;SignatureValue 仍对原始 SignedInfo 校验,签名算法与摘要白名单不变。

import { Convert } from 'xml-core'
import { Reference, SignedXml } from 'xmldsigjs'
import type { DigestReferenceSource } from 'xmldsigjs'
import type { IdpVerifyKey } from './cert'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { loadAndCheckSignature, selectSingleSignature } from './structure'

const TRANSFORM_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'

class RootReferenceSignedXml extends SignedXml {
  protected override async ValidateReferences(doc: DigestReferenceSource): Promise<boolean> {
    for (const reference of this.XmlSignature.SignedInfo.References.GetIterator()) {
      const element = reference.GetXml()
      if (!element) return false
      const rootReference = new Reference()
      rootReference.LoadXml(element)
      rootReference.Uri = ''
      const digest = await this.DigestReference(doc, rootReference, false)
      if (Convert.ToBase64(digest) !== Convert.ToBase64(reference.DigestValue)) return false
    }
    return true
  }
}

function hasEnvelopedTransform(signedXml: SignedXml): boolean {
  const reference = signedXml.XmlSignature.SignedInfo.References.Item(0)
  if (!reference) return false
  return reference.Transforms.GetIterator().some((t) => t.Algorithm === TRANSFORM_ENVELOPED)
}

export async function verifySaml11Signature(
  doc: Document,
  assertion: Element,
  keys: readonly IdpVerifyKey[],
): Promise<SamlResult<string>> {
  if (doc.documentElement !== assertion) {
    return failResult('signature_invalid', 'SAML 1.1 assertion must be the document root')
  }
  const selected = selectSingleSignature(assertion)
  if (!selected.ok) return failResult(selected.error.code, selected.error.reason)
  const loaded = loadAndCheckSignature(doc, selected.value.signature, assertion, {
    idAttribute: 'AssertionID',
  })
  if (!loaded.ok) return failResult(loaded.error.code, loaded.error.reason)
  if (!hasEnvelopedTransform(loaded.value)) {
    return failResult('signature_invalid', 'SAML 1.1 signature must use the enveloped transform')
  }
  const verifier = new RootReferenceSignedXml(doc)
  verifier.LoadXml(selected.value.signature)
  for (const key of keys) {
    try {
      if (await verifier.Verify(key.publicKey)) return okResult(key.fingerprint)
    } catch {
      // 证书轮换:单把失败继续试下一把。
    }
  }
  return failResult('signature_invalid', 'no configured IdP key verified the signature')
}
