// Assertion 语义校验。重放与 InResponseTo 一次性消费在 worker DO,本层无 binding。

import { SAMLP_NS, SAML_ASSERTION_NS } from './precheck'
import { assertionChild, assertionChildren } from './extract'
import { failResult, okResult } from './errors'
import type { SamlResult } from './errors'
import { DEFAULT_SAML_CLOCK_SKEW_MS, MAX_SAML_CLOCK_SKEW_MS } from './cert'
import { parseSamlInstant } from './instant'

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const SUBJECT_CONFIRMATION_BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer'
const A = SAML_ASSERTION_NS

export type SemanticInput = {
  responseRoot: Element
  assertion: Element
  expectedIssuer: string
  expectedAudience: string
  acsUrl: string
  // true/false 强制有无 InResponseTo;auto 按 Assertion 是否携带推断。
  spInitiated: boolean | 'auto'
  now: number
  // 默认 ±3min,上限 ±5min。
  clockSkewToleranceMs?: number
}

function checkStatus(responseRoot: Element): SamlResult<true> {
  const status = assertionChild(responseRoot, SAMLP_NS, 'Status')
  const code = status ? assertionChild(status, SAMLP_NS, 'StatusCode') : null
  const value = code?.getAttribute('Value') ?? ''
  if (value !== STATUS_SUCCESS) {
    return failResult('idp_status_error', `IdP status ${value}`, value || 'unknown')
  }
  return okResult(true)
}

function checkResponseDestination(responseRoot: Element, acsUrl: string): SamlResult<true> {
  const destination = responseRoot.getAttribute('Destination')
  if (destination !== null && destination !== acsUrl) {
    return failResult('recipient_mismatch', 'Response Destination != ACS')
  }
  return okResult(true)
}

function checkIssuer(assertion: Element, expected: string): SamlResult<string> {
  const issuer = assertionChild(assertion, A, 'Issuer')?.textContent?.trim() ?? ''
  if (issuer !== expected) return failResult('issuer_mismatch', `issuer "${issuer}"`)
  return okResult(issuer)
}

type TimeWindow = { notBefore: number; notOnOrAfter: number | null }

// 可选时间属性:缺省返回 fallback,存在但非法返回 undefined。
function optionalInstant(element: Element, name: string, fallback: number | null) {
  if (!element.hasAttribute(name)) return fallback
  return parseSamlInstant(element.getAttribute(name)) ?? undefined
}

// SAML Core 2.5.1:NotBefore/NotOnOrAfter 均可选,上界排他;Audience 须含本 SP。
function checkConditions(
  assertion: Element,
  expectedAudience: string,
  now: number,
  clockSkewToleranceMs: number,
): SamlResult<TimeWindow> {
  const conditions = assertionChild(assertion, A, 'Conditions')
  if (!conditions) return failResult('assertion_expired', 'Conditions missing')
  const issueInstant = parseSamlInstant(assertion.getAttribute('IssueInstant'))
  if (issueInstant === null) return failResult('assertion_expired', 'IssueInstant invalid')
  const nb = optionalInstant(conditions, 'NotBefore', issueInstant)
  const noa = optionalInstant(conditions, 'NotOnOrAfter', null)
  if (nb === undefined || noa === undefined || nb === null) {
    return failResult('assertion_expired', 'Conditions time invalid')
  }
  if (now + clockSkewToleranceMs < nb) return failResult('assertion_expired', 'NotBefore in future')
  if (noa !== null && now - clockSkewToleranceMs >= noa)
    return failResult('assertion_expired', 'NotOnOrAfter passed')

  const audiences: string[] = []
  for (const restriction of assertionChildren(conditions, A, 'AudienceRestriction')) {
    for (const aud of assertionChildren(restriction, A, 'Audience')) {
      if (aud.textContent) audiences.push(aud.textContent.trim())
    }
  }
  if (!audiences.includes(expectedAudience)) {
    return failResult('audience_mismatch', `audiences [${audiences.join(',')}]`)
  }
  return okResult({ notBefore: nb, notOnOrAfter: noa })
}

// SP-initiated 要求 InResponseTo;IdP-initiated 要求缺省,防两种模式混淆。
function checkInResponseTo(
  inResponseTo: string | null,
  spInitiated: boolean | 'auto',
): SamlResult<{ inResponseTo?: string }> {
  if (spInitiated === 'auto') {
    return inResponseTo ? okResult({ inResponseTo }) : okResult({})
  }
  if (spInitiated) {
    if (!inResponseTo)
      return failResult('recipient_mismatch', 'InResponseTo missing (SP-initiated)')
    return okResult({ inResponseTo })
  }
  if (inResponseTo)
    return failResult('recipient_mismatch', 'unexpected InResponseTo (IdP-initiated)')
  return okResult({})
}

// SAML Core 2.4.1.2:SubjectConfirmationData 的 NotBefore(可选)与 NotOnOrAfter 限定断言的投递窗口。
function checkSubjectConfirmation(
  input: SemanticInput,
  clockSkewToleranceMs: number,
): SamlResult<{ inResponseTo?: string; notOnOrAfter: number }> {
  const subject = assertionChild(input.assertion, A, 'Subject')
  const confirmation = subject ? assertionChild(subject, A, 'SubjectConfirmation') : null
  if (!confirmation) return failResult('recipient_mismatch', 'SubjectConfirmation missing')
  const data = confirmation ? assertionChild(confirmation, A, 'SubjectConfirmationData') : null
  if (!data) return failResult('recipient_mismatch', 'SubjectConfirmationData missing')

  if ((confirmation.getAttribute('Method') ?? '') !== SUBJECT_CONFIRMATION_BEARER) {
    return failResult('recipient_mismatch', 'SubjectConfirmation Method must be bearer')
  }
  if ((data.getAttribute('Recipient') ?? '') !== input.acsUrl) {
    return failResult('recipient_mismatch', 'Recipient != ACS')
  }
  const noa = parseSamlInstant(data.getAttribute('NotOnOrAfter'))
  if (noa === null) {
    return failResult('assertion_expired', 'SubjectConfirmation NotOnOrAfter invalid')
  }
  if (input.now - clockSkewToleranceMs >= noa) {
    return failResult('assertion_expired', 'SubjectConfirmation NotOnOrAfter passed')
  }
  const nb = optionalInstant(data, 'NotBefore', null)
  if (nb === undefined)
    return failResult('assertion_expired', 'SubjectConfirmation NotBefore invalid')
  if (nb !== null && input.now + clockSkewToleranceMs < nb) {
    return failResult('assertion_expired', 'SubjectConfirmation NotBefore in future')
  }
  const inResponseTo = checkInResponseTo(data.getAttribute('InResponseTo'), input.spInitiated)
  if (!inResponseTo.ok) return failResult(inResponseTo.error.code, inResponseTo.error.reason)
  return okResult({ ...inResponseTo.value, notOnOrAfter: noa })
}

// SAML Core 2.7.2:AuthnInstant 是用户实际认证时刻,复用 IdP 会话时早于本断言的 Conditions 属正常,
// 只拒绝未来时刻;SessionNotOnOrAfter 已过表示 IdP 会话已结束。
function checkAuthnStatement(
  assertion: Element,
  now: number,
  clockSkewToleranceMs: number,
): SamlResult<true> {
  const statements = assertionChildren(assertion, A, 'AuthnStatement')
  const statement = statements[0]
  if (statements.length !== 1 || !statement) {
    return failResult('assertion_expired', 'exactly one AuthnStatement is required')
  }
  const authnInstant = parseSamlInstant(statement.getAttribute('AuthnInstant'))
  if (authnInstant === null) return failResult('assertion_expired', 'AuthnInstant invalid')
  if (authnInstant > now + clockSkewToleranceMs) {
    return failResult('assertion_expired', 'AuthnInstant in future')
  }
  const sessionEnd = optionalInstant(statement, 'SessionNotOnOrAfter', null)
  if (sessionEnd === undefined)
    return failResult('assertion_expired', 'SessionNotOnOrAfter invalid')
  if (sessionEnd !== null && now - clockSkewToleranceMs >= sessionEnd) {
    return failResult('assertion_expired', 'SessionNotOnOrAfter passed')
  }
  return okResult(true)
}

export type SemanticOk = {
  issuer: string
  audience: string
  inResponseTo?: string
  assertionId: string
  notBefore: number
  notOnOrAfter: number
}

// 顺序校验,失败即返;assertionId 供 worker 重放集消费。
export function validateAssertionSemantics(input: SemanticInput): SamlResult<SemanticOk> {
  const clockSkewToleranceMs = input.clockSkewToleranceMs ?? DEFAULT_SAML_CLOCK_SKEW_MS
  if (
    !Number.isSafeInteger(clockSkewToleranceMs) ||
    clockSkewToleranceMs < 0 ||
    clockSkewToleranceMs > MAX_SAML_CLOCK_SKEW_MS
  ) {
    return failResult('assertion_expired', 'invalid SAML clock tolerance')
  }

  const status = checkStatus(input.responseRoot)
  if (!status.ok) return failResult(status.error.code, status.error.reason, status.error.idpStatus)

  const destination = checkResponseDestination(input.responseRoot, input.acsUrl)
  if (!destination.ok) return failResult(destination.error.code, destination.error.reason)

  const issuer = checkIssuer(input.assertion, input.expectedIssuer)
  if (!issuer.ok) return failResult(issuer.error.code, issuer.error.reason)

  const cond = checkConditions(
    input.assertion,
    input.expectedAudience,
    input.now,
    clockSkewToleranceMs,
  )
  if (!cond.ok) return failResult(cond.error.code, cond.error.reason)

  const confirm = checkSubjectConfirmation(input, clockSkewToleranceMs)
  if (!confirm.ok) return failResult(confirm.error.code, confirm.error.reason)

  const authn = checkAuthnStatement(input.assertion, input.now, clockSkewToleranceMs)
  if (!authn.ok) return failResult(authn.error.code, authn.error.reason)

  const assertionId = input.assertion.getAttribute('ID') ?? ''
  if (!assertionId) return failResult('signature_invalid', 'Assertion ID missing')

  // 断言可被接受的最晚时刻,供 worker 设置重放集 TTL。
  const conditionsEnd = cond.value.notOnOrAfter
  const notOnOrAfter =
    conditionsEnd === null
      ? confirm.value.notOnOrAfter
      : Math.min(conditionsEnd, confirm.value.notOnOrAfter)
  return okResult({
    issuer: issuer.value,
    audience: input.expectedAudience,
    ...(confirm.value.inResponseTo ? { inResponseTo: confirm.value.inResponseTo } : {}),
    assertionId,
    notBefore: cond.value.notBefore,
    notOnOrAfter,
  })
}
