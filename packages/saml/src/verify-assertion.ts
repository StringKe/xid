// 以 saml:Assertion 为根元素的 SAML 2.0 断言验证(WS-Fed RSTR 中的令牌):结构白名单 -> 断言签名(必需) -> 语义 -> 提取。
// 没有 samlp:Response 外壳,因此不校验 Status 与 Destination;InResponseTo 出现即拒绝。

import { DEFAULT_SAML_CLOCK_SKEW_MS, loadIdpVerifyKeys } from './cert'
import { failResult, okResult } from './errors'
import type { SamlResult, SamlVerifiedAssertion } from './errors'
import { extractSessionIndex, extractSubject, mapAttributes } from './extract'
import type { AttributeMapping } from './extract'
import { parseSecureXml } from './precheck'
import { validateSamlAssertionStructure } from './schema-assertion'
import { validateAssertionSemantics } from './semantics'
import { verifySignedElement } from './structure'

export type VerifySamlAssertionOptions = {
  idpCertificatesB64: readonly string[]
  expectedIssuer: string
  expectedAudience: string
  // SubjectConfirmationData Recipient 出现时必须等于它(WS-Fed 为 wreply 地址)。
  acsUrl: string
  // 默认 true。WS-Fed bearer token 可不带 Recipient。
  requireSubjectConfirmationRecipient?: boolean
  attributeMapping?: AttributeMapping
  now?: number
  // 默认 ±3min,上限 ±5min。
  clockSkewToleranceMs?: number
}

export async function verifySamlAssertion(
  assertionXml: string,
  options: VerifySamlAssertionOptions,
): Promise<SamlResult<SamlVerifiedAssertion>> {
  const now = options.now ?? Date.now()
  const parsed = parseSecureXml(assertionXml, 'Assertion')
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const assertion = parsed.value.documentElement
  const structure = validateSamlAssertionStructure(assertion)
  if (!structure.ok) return failResult(structure.error.code, structure.error.reason)

  const keys = await loadIdpVerifyKeys(options.idpCertificatesB64, {
    now,
    toleranceMs: options.clockSkewToleranceMs ?? DEFAULT_SAML_CLOCK_SKEW_MS,
  })
  if (!keys.ok) return failResult(keys.error.code, keys.error.reason)
  const fingerprint = await verifySignedElement(parsed.value, assertion, keys.value)
  if (!fingerprint.ok) return failResult(fingerprint.error.code, fingerprint.error.reason)

  const semantic = validateAssertionSemantics({
    assertion,
    expectedIssuer: options.expectedIssuer,
    expectedAudience: options.expectedAudience,
    acsUrl: options.acsUrl,
    spInitiated: false,
    now,
    ...(options.clockSkewToleranceMs !== undefined
      ? { clockSkewToleranceMs: options.clockSkewToleranceMs }
      : {}),
    ...(options.requireSubjectConfirmationRecipient !== undefined
      ? { requireSubjectConfirmationRecipient: options.requireSubjectConfirmationRecipient }
      : {}),
  })
  if (!semantic.ok) return { ok: false, error: semantic.error }

  const subject = extractSubject(assertion)
  if (!subject) return failResult('schema_invalid', 'Subject/NameID missing')
  const sessionIndex = extractSessionIndex(assertion)
  return okResult({
    assertionId: semantic.value.assertionId,
    issuer: semantic.value.issuer,
    audience: semantic.value.audience,
    subject,
    attributes: mapAttributes(assertion, options.attributeMapping ?? {}),
    signingCertFingerprint: fingerprint.value,
    notBefore: semantic.value.notBefore,
    notOnOrAfter: semantic.value.notOnOrAfter,
    subjectConfirmationNotOnOrAfter: semantic.value.subjectConfirmationNotOnOrAfter,
    ...(sessionIndex ? { sessionIndex } : {}),
  })
}
