// Sign-in & MFA 的各分节;每节只提交自己的字段,互不覆盖未保存的其他分节。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { SaveButton, SettingsBlock, settingsStyles } from './AuthSettingsLayout'
import { ChoiceCards, SaveStatus, SwitchRows } from './AuthSettingsControls'
import { useSaveOrgAuthPolicy } from './auth-queries'
import type {
  AuthPolicyInsights,
  MfaPolicy,
  OrgAuthPolicyView,
  SaveOrgAuthPolicyInput,
} from './auth-queries'
import type { HostedAuthMethodPolicy } from './types'

export const sectionStyles = stylex.create({
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
})

export type SectionProps = {
  orgId: string
  policy: OrgAuthPolicyView
  insights: AuthPolicyInsights | undefined
}

export function useSectionSave(orgId: string): {
  save: (payload: SaveOrgAuthPolicyInput) => void
  saved: boolean
  isPending: boolean
  error: XidError | null
} {
  const mutation = useSaveOrgAuthPolicy(orgId)
  const [saved, setSaved] = useState(false)
  function save(payload: SaveOrgAuthPolicyInput): void {
    setSaved(false)
    mutation.mutate(payload, { onSuccess: () => setSaved(true) })
  }
  return { save, saved, isPending: mutation.isPending, error: mutation.error }
}

function withMethod(method: HostedAuthMethodPolicy, enabled: boolean): HostedAuthMethodPolicy {
  return { ...method, enabled, allowLogin: enabled ? true : method.allowLogin }
}

type MethodToggles = {
  passkey: boolean
  password: boolean
  emailOtp: boolean
  magicLink: boolean
  phoneOtp: boolean
}

// 密码登录由 hostedAuth.password 与 org_policies.allow_password_login 共同决定,两者都允许才算开启。
export function passwordSignInEnabled(policy: OrgAuthPolicyView): boolean {
  return policy.hostedAuth.password.enabled && policy.loginPolicy.allowPasswordLogin
}

function methodToggles(policy: OrgAuthPolicyView): MethodToggles {
  const hostedAuth = policy.hostedAuth
  return {
    passkey: hostedAuth.passkey.enabled,
    password: passwordSignInEnabled(policy),
    emailOtp: hostedAuth.emailOtp.enabled,
    magicLink: hostedAuth.magicLink.enabled,
    phoneOtp: hostedAuth.smsOtp.enabled || hostedAuth.whatsappOtp.enabled,
  }
}

export function SignInMethodsSection({ orgId, policy, insights }: SectionProps): ReactNode {
  const [toggles, setToggles] = useState(() => methodToggles(policy))
  const { save, saved, isPending, error } = useSectionSave(orgId)
  const readiness = policy.deliveryChannelReadiness
  const phoneReady = readiness.smsOtp.configured || readiness.whatsappOtp.configured

  useEffect(() => setToggles(methodToggles(policy)), [policy])

  function set(key: keyof MethodToggles, value: boolean): void {
    setToggles((prev) => ({ ...prev, [key]: value }))
  }

  function submit(): void {
    const current = policy.hostedAuth
    save({
      loginPolicy: { allowPasswordLogin: toggles.password },
      hostedAuth: {
        ...current,
        passkey: withMethod(current.passkey, toggles.passkey),
        password: withMethod(current.password, toggles.password),
        emailOtp: withMethod(current.emailOtp, toggles.emailOtp),
        magicLink: withMethod(current.magicLink, toggles.magicLink),
        smsOtp: withMethod(current.smsOtp, toggles.phoneOtp && readiness.smsOtp.configured),
        whatsappOtp: withMethod(
          current.whatsappOtp,
          toggles.phoneOtp && readiness.whatsappOtp.configured,
        ),
      },
    })
  }

  return (
    <SettingsBlock
      id="methods"
      isFirst
      onSubmit={submit}
      title={<Trans>Sign-in methods</Trans>}
      description={
        <Trans>
          Hosted Auth shows the first method in this order and lists the rest under Try another way.
          It never looks up which methods a person has before they sign in. Social login and
          enterprise SSO have their own pages.
        </Trans>
      }
    >
      <SwitchRows
        rows={[
          {
            key: 'passkey',
            label: <Trans>Passkeys</Trans>,
            description: (
              <>
                <Trans>
                  Shown in the browser&apos;s autofill wherever the browser supports it.
                </Trans>{' '}
                {insights ? (
                  <Plural
                    value={insights.passkeySignIns30d}
                    one="# person signed in with a passkey in the last 30 days."
                    other="# people signed in with a passkey in the last 30 days."
                  />
                ) : null}
              </>
            ),
            checked: toggles.passkey,
            onChange: (value) => set('passkey', value),
          },
          {
            key: 'password',
            label: <Trans>Password</Trans>,
            description: (
              <>
                <Trans>At least 12 characters, breached passwords blocked.</Trans>{' '}
                {insights ? (
                  <Plural
                    value={insights.passwordUserCount}
                    one="# person still uses one."
                    other="# people still use one."
                  />
                ) : null}
              </>
            ),
            checked: toggles.password,
            onChange: (value) => set('password', value),
          },
          {
            key: 'emailOtp',
            label: <Trans>Email code</Trans>,
            description: (
              <Trans>A 6-digit code, valid for 10 minutes. Sent through Messaging.</Trans>
            ),
            checked: toggles.emailOtp,
            onChange: (value) => set('emailOtp', value),
          },
          {
            key: 'magicLink',
            label: <Trans>Magic link</Trans>,
            description: <Trans>A one-time sign-in link by email, valid for 15 minutes.</Trans>,
            checked: toggles.magicLink,
            onChange: (value) => set('magicLink', value),
          },
          {
            key: 'phoneOtp',
            label: <Trans>SMS and WhatsApp code</Trans>,
            description: phoneReady ? (
              <Trans>
                For people without a work email. Codes go only to the phone number prefixes your
                instance allows.
              </Trans>
            ) : (
              <Trans>Set up SMS or WhatsApp in Messaging before turning this on.</Trans>
            ),
            checked: toggles.phoneOtp,
            onChange: (value) => set('phoneOtp', value),
          },
        ]}
      />
      <SaveButton isPending={isPending}>
        <Trans>Save sign-in methods</Trans>
      </SaveButton>
      <SaveStatus error={error} saved={saved} />
    </SettingsBlock>
  )
}

export function TwoStepSection({ orgId, policy, insights }: SectionProps): ReactNode {
  const { t } = useLingui()
  const [value, setValue] = useState<MfaPolicy>(policy.effectiveMfaPolicy)
  const { save, saved, isPending, error } = useSectionSave(orgId)

  useEffect(() => setValue(policy.effectiveMfaPolicy), [policy.effectiveMfaPolicy])

  return (
    <SettingsBlock
      id="two-step"
      onSubmit={() => save({ mfaPolicy: value })}
      title={<Trans>Two-step verification</Trans>}
      description={
        <Trans>
          A passkey counts as both steps. Everyone else proves it a second way after their password
          or code.
        </Trans>
      }
    >
      <ChoiceCards<MfaPolicy>
        legend={t`Two-step verification`}
        value={value}
        onChange={setValue}
        options={[
          {
            value: 'disabled',
            label: <Trans>Off</Trans>,
            description: <Trans>No one is asked for a second step.</Trans>,
          },
          {
            value: 'optional',
            label: <Trans>Optional</Trans>,
            description: <Trans>People can turn it on from their account Security page.</Trans>,
          },
          {
            value: 'required',
            label: <Trans>Required for everyone</Trans>,
            description: (
              <>
                <Trans>People without a second factor set one up at their next sign-in.</Trans>{' '}
                {insights ? (
                  <Plural
                    value={insights.usersWithoutSecondFactor}
                    one="# person has not set one up yet."
                    other="# people have not set one up yet."
                  />
                ) : null}
              </>
            ),
          },
        ]}
      />
      {policy.mfaPolicy === null ? (
        <p {...stylex.props(settingsStyles.note)}>
          <Trans>
            This organization follows the instance default until you save a choice here.
          </Trans>
        </p>
      ) : null}
      <div {...stylex.props(sectionStyles.fieldGroup)}>
        <h3 {...stylex.props(settingsStyles.subTitle)}>
          <Trans>How people set it up</Trans>
        </h3>
        <p {...stylex.props(settingsStyles.note)}>
          <Trans>
            When two-step is required, people set it up during sign-in with an authenticator app or
            a passkey before they continue. Backup codes and SMS can be added later from their
            account; SMS can&apos;t be the only one. Email and WhatsApp codes never count as a
            second step.
          </Trans>
        </p>
      </div>
      <SaveButton isPending={isPending}>
        <Trans>Save two-step verification</Trans>
      </SaveButton>
      <SaveStatus error={error} saved={saved} />
    </SettingsBlock>
  )
}
