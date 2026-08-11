// Response 验签/解密/语义编排。重放与 InResponseTo 消费在 worker DO,本层只产出 assertionId/inResponseTo。

import { parseSecureXml } from './precheck'
import { validateSamlAssertionStructure, validateSamlResponseStructure } from './schema'
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
  idpCertificatesB64: readonly string[]
  expectedIssuer: string
  expectedAudience: string
  acsUrl: string
  // true/false 强制有无 InResponseTo;auto 按 Assertion 是否携带推断。
  spInitiated: boolean | 'auto'
  wantAuthnResponseSigned: boolean
  wantAssertionsSigned: boolean
  // EncryptedAssertion 时由 worker 传入不可导出私钥。
  spDecryptKey?: CryptoKey
  attributeMapping?: AttributeMapping
  now?: number
  // 默认 ±3min,上限 ±5min。
  clockSkewToleranceMs?: number
}

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
      // 证书轮换:单把失败继续试下一把。
    }
  }
  return { ok: false }
}

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
    const structure = validateSamlAssertionStructure(parsed.value.documentElement)
    if (!structure.ok) return failResult(structure.error.code, structure.error.reason)
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

async function verifyAndResolve(
  samlResponseXml: string,
  keys: readonly IdpVerifyKey[],
  options: VerifySamlOptions,
): Promise<SamlResult<VerifiedAssertionCtx>> {
  const parsed = parseSecureXml(samlResponseXml, 'Response')
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const responseRoot = parsed.value.documentElement
  const structure = validateSamlResponseStructure(responseRoot)
  if (!structure.ok) return failResult(structure.error.code, structure.error.reason)

  // 双 false 会跳过全部验签、接受任意伪造 Response,故回退强制 assertion 签名。
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

export async function verifySamlResponse(
  samlResponseXml: string,
  options: VerifySamlOptions,
): Promise<SamlResult<SamlVerifiedAssertion>> {
  const now = options.now ?? Date.now()
  const keysResult = await loadIdpVerifyKeys(options.idpCertificatesB64, {
    now,
    ...(options.clockSkewToleranceMs !== undefined
      ? { toleranceMs: options.clockSkewToleranceMs }
      : {}),
  })
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
    now,
    ...(options.clockSkewToleranceMs !== undefined
      ? { clockSkewToleranceMs: options.clockSkewToleranceMs }
      : {}),
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

// 供 worker 做 DO 重放消费(语义校验已断言存在)。
export function readAssertionId(assertion: Element): string {
  return assertion.getAttribute('ID') ?? ''
}
