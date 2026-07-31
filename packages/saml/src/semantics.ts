// 8.7 Assertion 语义校验(验签通过后顺序执行):issuer/时间窗/audience/recipient/InResponseTo/status。
// 重放(8.7 step 6)与 InResponseTo 一次性消费(8.7 step 4)依赖 Durable Object,本层只做纯断言;
// DO 交互由 worker/sso/saml.ts 在调用前后完成(本层无 binding,保持 packages/saml 纯净)。

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
  // 整个 Response 文档(取 Status,见 8.7 step 5)。
  responseRoot: Element
  // 已验证的明文 Assertion 元素(只从此元素提取)。
  assertion: Element
  // connection 配置的 IdP EntityID(8.7 step 1 精确匹配)。
  expectedIssuer: string
  // 本 SP EntityID(8.7 step 3 AudienceRestriction 命中)。
  expectedAudience: string
  // 本 ACS URL(8.7 step 4 Recipient 精确匹配)。
  acsUrl: string
  // true:要求 InResponseTo;false:要求缺省;auto:根据 Assertion 是否携带 InResponseTo 推断。
  spInitiated: boolean | 'auto'
  // 当前时间(ms),便于测试注入。
  now: number
  // connection 配置的时钟容忍,默认 +-3min,最大 +-5min。
  clockSkewToleranceMs?: number
}

// 8.7 step 5:samlp:Status/StatusCode/@Value == Success,否则透传 IdP 状态码报错。
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

// 8.7 step 1:Issuer 精确匹配 connection 配置 IdP EntityID。
function checkIssuer(assertion: Element, expected: string): SamlResult<string> {
  const issuer = assertionChild(assertion, A, 'Issuer')?.textContent?.trim() ?? ''
  if (issuer !== expected) return failResult('issuer_mismatch', `issuer "${issuer}"`)
  return okResult(issuer)
}

// 8.7 step 2 + 3:Conditions 时间窗(排他上界)+ AudienceRestriction 含本 SP。
function checkConditions(
  assertion: Element,
  expectedAudience: string,
  now: number,
  clockSkewToleranceMs: number,
): SamlResult<{ notBefore: number; notOnOrAfter: number }> {
  const conditions = assertionChild(assertion, A, 'Conditions')
  if (!conditions) return failResult('assertion_expired', 'Conditions missing')
  const nb = parseSamlInstant(conditions.getAttribute('NotBefore'))
  const noa = parseSamlInstant(conditions.getAttribute('NotOnOrAfter'))
  if (nb === null || noa === null) return failResult('assertion_expired', 'Conditions time missing')
  if (now + clockSkewToleranceMs < nb) return failResult('assertion_expired', 'NotBefore in future')
  if (now - clockSkewToleranceMs >= noa)
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

// SP-initiated 要求 InResponseTo 存在;IdP-initiated 要求缺省(防混淆,见 8.7 step 4)。
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

// 8.7 step 4:SubjectConfirmationData @Recipient/@NotOnOrAfter/@InResponseTo。返回 InResponseTo(SP-initiated)。
function checkSubjectConfirmation(
  input: SemanticInput,
  clockSkewToleranceMs: number,
): SamlResult<{ inResponseTo?: string }> {
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
  return checkInResponseTo(data.getAttribute('InResponseTo'), input.spInitiated)
}

function checkAuthnStatement(
  assertion: Element,
  now: number,
  freshnessNotBefore: number,
  clockSkewToleranceMs: number,
): SamlResult<true> {
  const statements = assertionChildren(assertion, A, 'AuthnStatement')
  if (statements.length !== 1) {
    return failResult('assertion_expired', 'exactly one AuthnStatement is required')
  }
  const authnInstant = parseSamlInstant(statements[0]?.getAttribute('AuthnInstant') ?? null)
  if (authnInstant === null) return failResult('assertion_expired', 'AuthnInstant invalid')
  if (authnInstant > now + clockSkewToleranceMs) {
    return failResult('assertion_expired', 'AuthnInstant in future')
  }
  if (authnInstant < freshnessNotBefore - clockSkewToleranceMs) {
    return failResult('assertion_expired', 'AuthnInstant predates Assertion freshness window')
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

// 顺序校验,任一失败立即返回(对应 8.8 错误分支)。返回 Assertion @ID 供重放集消费。
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

  const authn = checkAuthnStatement(
    input.assertion,
    input.now,
    cond.value.notBefore,
    clockSkewToleranceMs,
  )
  if (!authn.ok) return failResult(authn.error.code, authn.error.reason)

  const assertionId = input.assertion.getAttribute('ID') ?? ''
  if (!assertionId) return failResult('signature_invalid', 'Assertion ID missing')

  return okResult({
    issuer: issuer.value,
    audience: input.expectedAudience,
    ...(confirm.value.inResponseTo ? { inResponseTo: confirm.value.inResponseTo } : {}),
    assertionId,
    notBefore: cond.value.notBefore,
    notOnOrAfter: cond.value.notOnOrAfter,
  })
}
