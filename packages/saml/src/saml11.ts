// SAML 1.1 断言验证(WS-Fed RSTR 中 ADFS/Entra 签发的令牌):结构白名单 -> 验签 -> 语义 -> 提取。
// 断言必须带签名;重放与 wctx 关联由 worker 处理,本层产出 assertionId 与 notOnOrAfter。

import type { SamlAssertionResult, SamlSubject } from '@xid-kit/types'
import { DEFAULT_SAML_CLOCK_SKEW_MS, MAX_SAML_CLOCK_SKEW_MS, loadIdpVerifyKeys } from './cert'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import {
  assertionChild,
  assertionChildren,
  mapRawAttributes,
  normalizeNameIdFormat,
} from './extract'
import type { AttributeMapping } from './extract'
import { parseSamlInstant } from './instant'
import { SAML1_ASSERTION_NS, parseSecureXml } from './precheck'
import { verifySaml11Signature } from './saml11-signature'
import { validateSaml11AssertionStructure } from './schema-saml11'

const S = SAML1_ASSERTION_NS
const BEARER = 'urn:oasis:names:tc:SAML:1.0:cm:bearer'
const STATEMENTS = ['AuthenticationStatement', 'AttributeStatement'] as const

export type VerifySaml11Options = {
  idpCertificatesB64: readonly string[]
  expectedIssuer: string
  expectedAudience: string
  attributeMapping?: AttributeMapping
  now?: number
  // 默认 ±3min,上限 ±5min。
  clockSkewToleranceMs?: number
}

type TimeWindow = { notBefore: number; notOnOrAfter: number }

// SAML 1.1 Core 2.3.2.1:NotOnOrAfter 是重放集 TTL 的上界,缺省即拒绝;NotBefore 缺省取 IssueInstant。
function checkConditions(
  assertion: Element,
  options: VerifySaml11Options,
  now: number,
  skew: number,
): SamlResult<TimeWindow> {
  const conditions = assertionChild(assertion, S, 'Conditions')
  if (!conditions) return failResult('assertion_expired', 'Conditions missing')
  const issueInstant = parseSamlInstant(assertion.getAttribute('IssueInstant'))
  const notBefore = conditions.hasAttribute('NotBefore')
    ? parseSamlInstant(conditions.getAttribute('NotBefore'))
    : issueInstant
  const notOnOrAfter = parseSamlInstant(conditions.getAttribute('NotOnOrAfter'))
  if (notBefore === null || notOnOrAfter === null) {
    return failResult('assertion_expired', 'Conditions NotOnOrAfter is required')
  }
  if (now + skew < notBefore) return failResult('assertion_expired', 'NotBefore in future')
  if (now - skew >= notOnOrAfter) return failResult('assertion_expired', 'NotOnOrAfter passed')

  // 每个 AudienceRestrictionCondition 都必须满足(条件之间是与关系)。
  const restrictions = assertionChildren(conditions, S, 'AudienceRestrictionCondition')
  if (restrictions.length === 0)
    return failResult('audience_mismatch', 'AudienceRestrictionCondition missing')
  for (const restriction of restrictions) {
    const audiences = assertionChildren(restriction, S, 'Audience').map(
      (a) => a.textContent?.trim() ?? '',
    )
    if (!audiences.includes(options.expectedAudience)) {
      return failResult('audience_mismatch', `audiences [${audiences.join(',')}]`)
    }
  }
  return okResult({ notBefore, notOnOrAfter })
}

// 所有语句的 Subject 必须是同一主体,且确认方式包含 bearer。
function checkSubjects(assertion: Element): SamlResult<SamlSubject> {
  let subject: SamlSubject | null = null
  for (const name of STATEMENTS) {
    const statement = assertionChild(assertion, S, name)
    const element = statement ? assertionChild(statement, S, 'Subject') : null
    if (!statement) continue
    if (!element) return failResult('schema_invalid', `${name} Subject missing`)
    const nameIdentifier = assertionChild(element, S, 'NameIdentifier')
    const confirmation = assertionChild(element, S, 'SubjectConfirmation')
    const methods = confirmation
      ? assertionChildren(confirmation, S, 'ConfirmationMethod').map((m) => m.textContent?.trim())
      : []
    if (!methods.includes(BEARER)) {
      return failResult('recipient_mismatch', 'SubjectConfirmation must include bearer')
    }
    const current: SamlSubject = {
      nameId: nameIdentifier?.textContent?.trim() ?? '',
      nameIdFormat: normalizeNameIdFormat(nameIdentifier?.getAttribute('Format') ?? null),
    }
    if (!current.nameId) return failResult('schema_invalid', 'NameIdentifier missing')
    if (
      subject &&
      (subject.nameId !== current.nameId || subject.nameIdFormat !== current.nameIdFormat)
    ) {
      return failResult('schema_invalid', 'statements name different subjects')
    }
    subject = current
  }
  return subject ? okResult(subject) : failResult('schema_invalid', 'Subject missing')
}

function checkAuthenticationInstant(
  assertion: Element,
  now: number,
  skew: number,
): SamlResult<true> {
  const statement = assertionChild(assertion, S, 'AuthenticationStatement')
  if (!statement) return okResult(true)
  const instant = parseSamlInstant(statement.getAttribute('AuthenticationInstant'))
  if (instant === null) return failResult('assertion_expired', 'AuthenticationInstant invalid')
  if (instant > now + skew)
    return failResult('assertion_expired', 'AuthenticationInstant in future')
  return okResult(true)
}

// SAML 1.1 属性按「AttributeNamespace/AttributeName」作为键,与 ADFS 在 SAML 2.0 中使用的 claim URI 一致。
function rawSaml11Attributes(assertion: Element): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const statement = assertionChild(assertion, S, 'AttributeStatement')
  if (!statement) return out
  for (const attribute of assertionChildren(statement, S, 'Attribute')) {
    const namespace = (attribute.getAttribute('AttributeNamespace') ?? '').replace(/\/+$/, '')
    const name = attribute.getAttribute('AttributeName') ?? ''
    const key = namespace ? `${namespace}/${name}` : name
    out[key] = assertionChildren(attribute, S, 'AttributeValue')
      .map((value) => value.textContent?.trim() ?? '')
      .filter((value) => value.length > 0)
  }
  return out
}

function resolveSkew(options: VerifySaml11Options): SamlResult<number> {
  const skew = options.clockSkewToleranceMs ?? DEFAULT_SAML_CLOCK_SKEW_MS
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > MAX_SAML_CLOCK_SKEW_MS) {
    return failResult('assertion_expired', 'invalid SAML clock tolerance')
  }
  return okResult(skew)
}

export async function verifySaml11Assertion(
  assertionXml: string,
  options: VerifySaml11Options,
): Promise<SamlResult<SamlAssertionResult>> {
  const now = options.now ?? Date.now()
  const skew = resolveSkew(options)
  if (!skew.ok) return failResult(skew.error.code, skew.error.reason)
  const parsed = parseSecureXml(assertionXml, 'Assertion', S)
  if (!parsed.ok) return failResult(parsed.error.code, parsed.error.reason)
  const assertion = parsed.value.documentElement
  const structure = validateSaml11AssertionStructure(assertion)
  if (!structure.ok) return failResult(structure.error.code, structure.error.reason)

  const keys = await loadIdpVerifyKeys(options.idpCertificatesB64, { now, toleranceMs: skew.value })
  if (!keys.ok) return failResult(keys.error.code, keys.error.reason)
  const fingerprint = await verifySaml11Signature(parsed.value, assertion, keys.value)
  if (!fingerprint.ok) return failResult(fingerprint.error.code, fingerprint.error.reason)

  const issuer = assertion.getAttribute('Issuer') ?? ''
  if (issuer !== options.expectedIssuer) return failResult('issuer_mismatch', `issuer "${issuer}"`)
  const window = checkConditions(assertion, options, now, skew.value)
  if (!window.ok) return failResult(window.error.code, window.error.reason)
  const subject = checkSubjects(assertion)
  if (!subject.ok) return failResult(subject.error.code, subject.error.reason)
  const authn = checkAuthenticationInstant(assertion, now, skew.value)
  if (!authn.ok) return failResult(authn.error.code, authn.error.reason)

  return okResult({
    assertionId: assertion.getAttribute('AssertionID') ?? '',
    issuer,
    audience: options.expectedAudience,
    subject: subject.value,
    attributes: mapRawAttributes(rawSaml11Attributes(assertion), options.attributeMapping ?? {}),
    signingCertFingerprint: fingerprint.value,
    notBefore: window.value.notBefore,
    notOnOrAfter: window.value.notOnOrAfter,
  })
}
