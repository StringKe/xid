// 出站 SAML IdP 的认证上下文:会话实际认证方式 -> AuthnContextClassRef,
// 并按 RequestedAuthnContext 的 Comparison(SAML Core 3.3.2.2.1)判定能否满足。

import type { AuthnContextComparison, RequestedAuthnContext } from '@xid-kit/saml'
import type { AmrValue } from '@xid-kit/types'

export const AUTHN_CONTEXT_CLASS = {
  unspecified: 'urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified',
  password: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
  passwordProtectedTransport: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  refedsMfa: 'https://refeds.org/profile/mfa',
} as const

// 强度序由 IdP 定义(SAML Core 3.3.2.2.1)。所有交互都走 HTTPS,密码登录同时满足 Password 与 PasswordProtectedTransport。
const CLASS_STRENGTH: ReadonlyMap<string, number> = new Map([
  [AUTHN_CONTEXT_CLASS.unspecified, 0],
  [AUTHN_CONTEXT_CLASS.password, 1],
  [AUTHN_CONTEXT_CLASS.passwordProtectedTransport, 2],
  [AUTHN_CONTEXT_CLASS.refedsMfa, 3],
])

export type AuthnFacts = {
  amr: readonly AmrValue[]
  isAal2: boolean
  // 社交登录与企业 SSO:amr 沿用 'pwd',但 XID 没有校验密码,不能断言密码类 class。
  isFederated: boolean
}

export type AuthnContextDecision =
  | { kind: 'satisfied'; classRef: string }
  | { kind: 'step_up' }
  | { kind: 'reauthenticate' }
  | { kind: 'unsatisfiable' }

function achievedClasses(facts: AuthnFacts): string[] {
  const classes: string[] = [AUTHN_CONTEXT_CLASS.unspecified]
  if (!facts.isFederated && facts.amr.includes('pwd')) {
    classes.push(AUTHN_CONTEXT_CLASS.password, AUTHN_CONTEXT_CLASS.passwordProtectedTransport)
  }
  if (facts.isAal2) classes.push(AUTHN_CONTEXT_CLASS.refedsMfa)
  return classes
}

function strength(classRef: string): number {
  return CLASS_STRENGTH.get(classRef) ?? -1
}

function strongest(classes: readonly string[]): string | null {
  let best: string | null = null
  for (const classRef of classes) {
    if (best === null || strength(classRef) > strength(best)) best = classRef
  }
  return best
}

function knownLevels(classRefs: readonly string[]): number[] {
  return classRefs.filter((ref) => CLASS_STRENGTH.has(ref)).map(strength)
}

function matchComparison(
  comparison: AuthnContextComparison,
  classRefs: readonly string[],
  achieved: readonly string[],
): string | null {
  const levels = knownLevels(classRefs)
  if (levels.length === 0) return null
  if (comparison === 'exact') return classRefs.find((ref) => achieved.includes(ref)) ?? null
  if (comparison === 'minimum') {
    const best = strongest(achieved)
    return best !== null && strength(best) >= Math.min(...levels) ? best : null
  }
  if (comparison === 'better') {
    // 未知 class 的强度无从比较,无法证明「强于全部」。
    if (levels.length !== classRefs.length) return null
    const best = strongest(achieved)
    return best !== null && strength(best) > Math.max(...levels) ? best : null
  }
  const ceiling = Math.max(...levels)
  const candidates = achieved.filter(
    (ref) =>
      strength(ref) <= ceiling &&
      (ref !== AUTHN_CONTEXT_CLASS.unspecified || classRefs.includes(ref)),
  )
  return strongest(candidates)
}

function match(requested: RequestedAuthnContext | null, facts: AuthnFacts): string | null {
  const achieved = achievedClasses(facts)
  if (requested === null) return strongest(achieved)
  // XID 不发布 AuthnContextDeclRef,按 declaration 的请求一律无法满足。
  if (requested.declRefs.length > 0) return null
  return matchComparison(requested.comparison, requested.classRefs, achieved)
}

const STRONGEST_FACTS: AuthnFacts = { amr: ['pwd', 'mfa'], isAal2: true, isFederated: false }

// 当前认证满足时给出实际 ClassRef;否则判断补一次 MFA(step-up)或重新登录是否可能满足。
export function decideAuthnContext(input: {
  requested: RequestedAuthnContext | null
  current: AuthnFacts
}): AuthnContextDecision {
  const classRef = match(input.requested, input.current)
  if (classRef !== null) return { kind: 'satisfied', classRef }
  if (match(input.requested, STRONGEST_FACTS) === null) return { kind: 'unsatisfiable' }
  if (
    !input.current.isAal2 &&
    match(input.requested, { ...input.current, isAal2: true }) !== null
  ) {
    return { kind: 'step_up' }
  }
  // maximum 上限低于当前会话时,重新登录多半仍走同一方式;只给一次机会,由调用方防循环。
  return { kind: 'reauthenticate' }
}
