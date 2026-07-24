// SAML Response 验签 + 解密 + 语义校验编排(04 章 8.0-8.7 端到端)。
// 顺序:解码 -> 预检/解析 -> 验 Response 签名(可选)-> 取明文 Assertion(直接或解密)->
//       验 Assertion 签名(可选)-> 语义校验 -> 提取 Subject/Attributes。
// 验签核心(digest + SignatureValue)由 xmldsigjs 走注入的 crypto.subtle 真实执行(见 engine.ts、spike)。
// 重放 / InResponseTo 一次性消费依赖 DO,本层只产出 assertionId/inResponseTo,DO 交互在 worker 完成。

import { parseSecureXml } from './precheck'
import { loadIdpVerifyKeys } from './cert'
import type { IdpVerifyKey } from './cert'
import { selectSingleSignature, loadAndCheckSignature } from './structure'
import { decryptEncryptedAssertion, hasEncryptedAssertion, plaintextAssertion } from './decrypt'
import { validateAssertionSemantics } from './semantics'
import { extractSessionIndex, extractSubject, mapAttributes } from './extract'
import type { AttributeMapping } from './extract'
import { failResult, okResult } from './errors'
import type { SamlResult, SamlVerifiedAssertion } from './errors'

export type VerifySamlOptions = {
  // connection 存的 IdP X.509 证书(base64 DER,轮换期可多把,8.5 step 1)。
  idpCertificatesB64: readonly string[]
  // connection 配置 IdP EntityID(8.7 step 1)。
  expectedIssuer: string
  // 本 SP EntityID(AudienceRestriction,8.7 step 3)。
  expectedAudience: string
  // 本 ACS URL(Recipient,8.7 step 4)。
  acsUrl: string
  // true 要求 InResponseTo,false 要求缺省,auto 根据已验签 Assertion 是否携带 InResponseTo 推断。
  spInitiated: boolean | 'auto'
  // 签名要求开关(默认均 true,见 8.3)。
  wantAuthnResponseSigned: boolean
  wantAssertionsSigned: boolean
  // EncryptedAssertion 时的 SP 解密私钥(不可导出 CryptoKey,见 decrypt.ts)。
  spDecryptKey?: CryptoKey
  // attributeMapping(connection 级)。
  attributeMapping?: AttributeMapping
  now?: number
}

// 用任一 IdP 公钥验过 signedXml(轮换期任一验过即可,8.5 step 1)。返回命中证书指纹。
async function verifyWithAnyKey(
  signedXml: ReturnType<typeof loadAndCheckSignature>,
  keys: readonly IdpVerifyKey[],
): Promise<{ ok: boolean; fingerprint?: string }> {
  if (!signedXml.ok) return { ok: false }
  for (const key of keys) {
    try {
      if (await signedXml.value.Verify(key.publicKey))
        return { ok: true, fingerprint: key.fingerprint }
    } catch {
      // 单把密钥验签抛错视为该把失败,继续尝试下一把。
    }
  }
  return { ok: false }
}

// 对一个元素(Response 或 Assertion)做完整签名链校验(结构 + 算法白名单 + 验签)。
async function verifyElementSignature(
  doc: Document,
  signedElement: Element,
  keys: readonly IdpVerifyKey[],
): Promise<SamlResult<string>> {
  const selected = selectSingleSignature(signedElement)
  if (!selected.ok) return failResult(selected.error.code, selected.error.reason)
  const loaded = loadAndCheckSignature(doc, selected.value.signature, signedElement)
  if (!loaded.ok) return failResult(loaded.error.code, loaded.error.reason)
  const verified = await verifyWithAnyKey(loaded, keys)
  if (!verified.ok || !verified.fingerprint) {
    return failResult('signature_invalid', 'no configured IdP key verified the signature')
  }
  return okResult(verified.fingerprint)
}

// 取明文 Assertion DOM:直接明文,或 EncryptedAssertion 解密后再经预检/解析(8.6 step 4)。
async function resolveAssertion(
  responseRoot: Element,
  doc: Document,
  options: VerifySamlOptions,
): Promise<SamlResult<{ assertion: Element; doc: Document }>> {
  if (hasEncryptedAssertion(responseRoot)) {
    if (!options.spDecryptKey) return failResult('decryption_failed', 'SP decrypt key unavailable')
    const decrypted = await decryptEncryptedAssertion(responseRoot, options.spDecryptKey)
    if (!decrypted.ok) return failResult(decrypted.error.code, decrypted.error.reason)
    const parsed = parseSecureXml(decrypted.value, 'Assertion')
    if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
    return okResult({ assertion: parsed.value.documentElement, doc: parsed.value })
  }
  const assertion = plaintextAssertion(responseRoot)
  if (!assertion) return failResult('schema_invalid', 'no Assertion in Response')
  return okResult({ assertion, doc })
}

type VerifiedAssertionCtx = {
  responseRoot: Element
  assertion: Element
  fingerprint: string
}

// 解析 + 验 Response/Assertion 签名 + 取明文 Assertion,产出待语义校验的上下文。
async function verifyAndResolve(
  samlResponseXml: string,
  keys: readonly IdpVerifyKey[],
  options: VerifySamlOptions,
): Promise<SamlResult<VerifiedAssertionCtx>> {
  const parsed = parseSecureXml(samlResponseXml, 'Response')
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const responseRoot = parsed.value.documentElement

  // SAML 安全基线:至少 assertion 必须被签。双 false 配置(两个开关都关)会跳过全部验签,
  // 等于接受任意伪造 Response,回退到强制 assertion 签名(见 8.6「默认拒绝只签 Response」)。
  const wantAssertionsSigned = options.wantAssertionsSigned || !options.wantAuthnResponseSigned

  let responseFingerprint: string | undefined
  if (options.wantAuthnResponseSigned) {
    const sig = await verifyElementSignature(parsed.value, responseRoot, keys)
    if (!sig.ok) return failResult(sig.error.code, sig.error.reason)
    responseFingerprint = sig.value
  }

  const resolved = await resolveAssertion(responseRoot, parsed.value, options)
  if (!resolved.ok) return failResult(resolved.error.code, resolved.error.reason)
  const { assertion, doc: assertionDoc } = resolved.value

  let assertionFingerprint: string | undefined
  if (wantAssertionsSigned) {
    const sig = await verifyElementSignature(assertionDoc, assertion, keys)
    if (!sig.ok) return failResult(sig.error.code, sig.error.reason)
    assertionFingerprint = sig.value
  }

  return okResult({
    responseRoot,
    assertion,
    fingerprint: assertionFingerprint ?? responseFingerprint ?? '',
  })
}

// 端到端验签 + 语义校验,产出已验证 Assertion 结果(进入 JIT)。
export async function verifySamlResponse(
  samlResponseXml: string,
  options: VerifySamlOptions,
): Promise<SamlResult<SamlVerifiedAssertion>> {
  const keysResult = await loadIdpVerifyKeys(options.idpCertificatesB64)
  if (!keysResult.ok) return failResult(keysResult.error.code, keysResult.error.reason)

  const ctx = await verifyAndResolve(samlResponseXml, keysResult.value, options)
  if (!ctx.ok) return failResult(ctx.error.code, ctx.error.reason)

  const semantic = validateAssertionSemantics({
    responseRoot: ctx.value.responseRoot,
    assertion: ctx.value.assertion,
    expectedIssuer: options.expectedIssuer,
    expectedAudience: options.expectedAudience,
    acsUrl: options.acsUrl,
    spInitiated: options.spInitiated,
    now: options.now ?? Date.now(),
  })
  if (!semantic.ok) return { ok: false, error: semantic.error }

  const subject = extractSubject(ctx.value.assertion)
  if (!subject) return failResult('schema_invalid', 'Subject/NameID missing')

  const sessionIndex = extractSessionIndex(ctx.value.assertion)
  return okResult({
    assertionId: semantic.value.assertionId,
    issuer: semantic.value.issuer,
    audience: semantic.value.audience,
    subject,
    attributes: mapAttributes(ctx.value.assertion, options.attributeMapping ?? {}),
    ...(semantic.value.inResponseTo ? { inResponseTo: semantic.value.inResponseTo } : {}),
    signingCertFingerprint: ctx.value.fingerprint,
    notBefore: semantic.value.notBefore,
    notOnOrAfter: semantic.value.notOnOrAfter,
    ...(sessionIndex ? { sessionIndex } : {}),
  })
}

// 暴露 assertionId 供 worker 做 DO 重放消费(语义校验已断言其存在)。
export function readAssertionId(assertion: Element): string {
  return assertion.getAttribute('ID') ?? ''
}
