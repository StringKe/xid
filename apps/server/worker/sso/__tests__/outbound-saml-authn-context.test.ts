// outbound-saml-authn-context.ts:会话认证方式 -> AuthnContextClassRef 与四种 Comparison 的判定。

import { describe, expect, it } from 'vitest'
import type { RequestedAuthnContext } from '@xid-kit/saml'
import { AUTHN_CONTEXT_CLASS, decideAuthnContext } from '../outbound-saml-authn-context'
import type { AuthnFacts } from '../outbound-saml-authn-context'

const PASSWORD: AuthnFacts = { amr: ['pwd'], isAal2: false, isFederated: false }
const PASSWORD_MFA: AuthnFacts = { amr: ['pwd', 'otp', 'mfa'], isAal2: true, isFederated: false }
const PASSKEY: AuthnFacts = { amr: ['phr'], isAal2: true, isFederated: false }
const EMAIL_OTP: AuthnFacts = { amr: ['email'], isAal2: false, isFederated: false }
const FEDERATED: AuthnFacts = { amr: ['pwd'], isAal2: false, isFederated: true }
const FEDERATED_MFA: AuthnFacts = { amr: ['pwd', 'otp', 'mfa'], isAal2: true, isFederated: true }

const PPT = AUTHN_CONTEXT_CLASS.passwordProtectedTransport
const MFA = AUTHN_CONTEXT_CLASS.refedsMfa
const UNKNOWN = 'urn:example:ac:classes:Retina'

function requested(
  comparison: RequestedAuthnContext['comparison'],
  classRefs: string[],
  declRefs: string[] = [],
): RequestedAuthnContext {
  return { comparison, classRefs, declRefs }
}

describe('decideAuthnContext without RequestedAuthnContext', () => {
  it.each([
    ['a password session', PASSWORD, PPT],
    ['a password plus MFA session', PASSWORD_MFA, MFA],
    ['a passkey session', PASSKEY, MFA],
    ['an email OTP session', EMAIL_OTP, AUTHN_CONTEXT_CLASS.unspecified],
    [
      'a session without amr',
      { amr: [], isAal2: false, isFederated: false },
      AUTHN_CONTEXT_CLASS.unspecified,
    ],
    ['a social or enterprise SSO session', FEDERATED, AUTHN_CONTEXT_CLASS.unspecified],
    ['a federated session after an MFA step-up', FEDERATED_MFA, MFA],
  ])('asserts the strongest class achieved by %s', (_label, current, expected) => {
    const decision = decideAuthnContext({ requested: null, current })

    expect(decision).toEqual({ kind: 'satisfied', classRef: expected })
  })
})

describe('decideAuthnContext for federated sessions', () => {
  it('does not treat a federated session as a password login', () => {
    const decision = decideAuthnContext({
      requested: requested('exact', [PPT]),
      current: FEDERATED,
    })

    expect(decision).toEqual({ kind: 'reauthenticate' })
  })

  it('still satisfies an MFA floor once the federated session reached AAL2', () => {
    const decision = decideAuthnContext({
      requested: requested('minimum', [MFA]),
      current: FEDERATED_MFA,
    })

    expect(decision).toEqual({ kind: 'satisfied', classRef: MFA })
  })
})

describe('decideAuthnContext exact', () => {
  it('asserts the requested class the session achieved', () => {
    const decision = decideAuthnContext({
      requested: requested('exact', [AUTHN_CONTEXT_CLASS.password]),
      current: PASSWORD_MFA,
    })

    expect(decision).toEqual({ kind: 'satisfied', classRef: AUTHN_CONTEXT_CLASS.password })
  })

  it('asks a password session for step-up when only MFA is accepted', () => {
    const decision = decideAuthnContext({ requested: requested('exact', [MFA]), current: PASSWORD })

    expect(decision).toEqual({ kind: 'step_up' })
  })

  it('asks a passkey session to sign in again when only a password class is accepted', () => {
    const decision = decideAuthnContext({ requested: requested('exact', [PPT]), current: PASSKEY })

    expect(decision).toEqual({ kind: 'reauthenticate' })
  })

  it('cannot satisfy a class XID does not know', () => {
    const decision = decideAuthnContext({
      requested: requested('exact', [UNKNOWN]),
      current: PASSKEY,
    })

    expect(decision).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('decideAuthnContext minimum', () => {
  it('asserts the stronger class the session achieved', () => {
    const decision = decideAuthnContext({
      requested: requested('minimum', [PPT]),
      current: PASSKEY,
    })

    expect(decision).toEqual({ kind: 'satisfied', classRef: MFA })
  })

  it('ignores unknown classes when a known one sets the floor', () => {
    const decision = decideAuthnContext({
      requested: requested('minimum', [UNKNOWN, PPT]),
      current: PASSWORD,
    })

    expect(decision).toEqual({ kind: 'satisfied', classRef: PPT })
  })

  it('asks an email OTP session for MFA step-up when MFA is the floor', () => {
    const decision = decideAuthnContext({
      requested: requested('minimum', [MFA]),
      current: EMAIL_OTP,
    })

    expect(decision).toEqual({ kind: 'step_up' })
  })
})

describe('decideAuthnContext better', () => {
  it('asserts MFA when the SP asks for better than a password', () => {
    const decision = decideAuthnContext({
      requested: requested('better', [PPT]),
      current: PASSWORD_MFA,
    })

    expect(decision).toEqual({ kind: 'satisfied', classRef: MFA })
  })

  it('cannot satisfy better than the strongest class XID issues', () => {
    const decision = decideAuthnContext({ requested: requested('better', [MFA]), current: PASSKEY })

    expect(decision).toEqual({ kind: 'unsatisfiable' })
  })

  it('cannot prove better than an unknown class', () => {
    const decision = decideAuthnContext({
      requested: requested('better', [AUTHN_CONTEXT_CLASS.password, UNKNOWN]),
      current: PASSWORD_MFA,
    })

    expect(decision).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('decideAuthnContext maximum', () => {
  it('asserts the strongest class within the ceiling', () => {
    const decision = decideAuthnContext({
      requested: requested('maximum', [PPT]),
      current: PASSWORD_MFA,
    })

    expect(decision).toEqual({ kind: 'satisfied', classRef: PPT })
  })

  it('asks a passkey-only session to sign in again when the ceiling is below MFA', () => {
    const decision = decideAuthnContext({
      requested: requested('maximum', [PPT]),
      current: PASSKEY,
    })

    expect(decision).toEqual({ kind: 'reauthenticate' })
  })

  it('does not fall back to unspecified unless the SP listed it', () => {
    const decision = decideAuthnContext({
      requested: requested('maximum', [AUTHN_CONTEXT_CLASS.password]),
      current: EMAIL_OTP,
    })

    expect(decision).toEqual({ kind: 'reauthenticate' })
  })
})

describe('decideAuthnContext declaration references', () => {
  it('cannot satisfy an AuthnContextDeclRef request', () => {
    const decision = decideAuthnContext({
      requested: requested('exact', [], ['urn:example:decl:1']),
      current: PASSWORD_MFA,
    })

    expect(decision).toEqual({ kind: 'unsatisfiable' })
  })
})
