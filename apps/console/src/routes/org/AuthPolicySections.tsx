// Sign-in & MFA 的各分节;每节只提交自己的字段,互不覆盖未保存的其他分节。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Switch } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { SaveButton, SettingsBlock, settingsStyles } from './AuthSettingsLayout'
import { ChoiceCards, SaveStatus, SwitchRows, UnitField, UnitFields } from './AuthSettingsControls'
import { useSaveOrgAuthPolicy } from './auth-queries'
import type {
  AuthPolicyInsights,
  MfaPolicy,
  OrgAuthPolicyView,
  SaveOrgAuthPolicyInput,
  SsoConnectionView,
} from './auth-queries'
import type { HostedAuthMethodPolicy, HostedAuthPolicy } from './types'

const MINUTES_PER_DAY = 1440

const styles = stylex.create({
  domainRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 48rem)': '12.5rem minmax(0, 1fr) auto',
    },
    alignItems: 'center',
    gap: '0.25rem 1rem',
    minHeight: '3.25rem',
    paddingBlock: '0.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
    lineHeight: leading.sm,
  },
  domain: {
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
    overflowWrap: 'anywhere',
  },
  connection: {
    gridColumn: { default: '1 / -1', '@media (min-width: 48rem)': 'auto' },
    gridRow: { default: 2, '@media (min-width: 48rem)': 'auto' },
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  people: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
})

type SectionProps = {
  orgId: string
  policy: OrgAuthPolicyView
  insights: AuthPolicyInsights | undefined
}

function useSectionSave(orgId: string) {
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

function methodToggles(hostedAuth: HostedAuthPolicy): MethodToggles {
  return {
    passkey: hostedAuth.passkey.enabled,
    password: hostedAuth.password.enabled,
    emailOtp: hostedAuth.emailOtp.enabled,
    magicLink: hostedAuth.magicLink.enabled,
    phoneOtp: hostedAuth.smsOtp.enabled || hostedAuth.whatsappOtp.enabled,
  }
}

export function SignInMethodsSection({ orgId, policy, insights }: SectionProps): ReactNode {
  const [toggles, setToggles] = useState(() => methodToggles(policy.hostedAuth))
  const { save, saved, isPending, error } = useSectionSave(orgId)
  const readiness = policy.deliveryChannelReadiness
  const phoneReady = readiness.smsOtp.configured || readiness.whatsappOtp.configured

  useEffect(() => setToggles(methodToggles(policy.hostedAuth)), [policy.hostedAuth])

  function set(key: keyof MethodToggles, value: boolean): void {
    setToggles((prev) => ({ ...prev, [key]: value }))
  }

  function submit(): void {
    const current = policy.hostedAuth
    save({
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
      <div {...stylex.props(styles.fieldGroup)}>
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

function toText(value: number | null, divisor: number): string {
  if (value === null) return ''
  return String(Math.round((value / divisor) * 100) / 100)
}

function fromText(value: string, multiplier: number): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : null
}

type LifetimeForm = {
  absoluteDays: string
  idleDays: string
  accessMinutes: string
  refreshAbsoluteDays: string
  refreshIdleDays: string
}

function lifetimeForm(policy: OrgAuthPolicyView): LifetimeForm {
  return {
    absoluteDays: toText(policy.sessionPolicy.absoluteTimeoutDays, 1),
    idleDays: toText(policy.sessionPolicy.idleTimeoutMin, MINUTES_PER_DAY),
    accessMinutes: toText(policy.tokenPolicy.accessTokenTtlSec, 60),
    refreshAbsoluteDays: toText(policy.tokenPolicy.refreshAbsoluteTimeoutDays, 1),
    refreshIdleDays: toText(policy.tokenPolicy.refreshIdleTimeoutDays, 1),
  }
}

export function SessionsSection({ orgId, policy }: SectionProps): ReactNode {
  const { t } = useLingui()
  const [form, setForm] = useState(() => lifetimeForm(policy))
  const { save, saved, isPending, error } = useSectionSave(orgId)

  useEffect(() => setForm(lifetimeForm(policy)), [policy])

  function patch(key: keyof LifetimeForm, value: string): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function submit(): void {
    save({
      sessionPolicy: {
        absoluteTimeoutDays: fromText(form.absoluteDays, 1),
        idleTimeoutMin: fromText(form.idleDays, MINUTES_PER_DAY),
      },
      tokenPolicy: {
        ...policy.tokenPolicy,
        accessTokenTtlSec: fromText(form.accessMinutes, 60),
        refreshAbsoluteTimeoutDays: fromText(form.refreshAbsoluteDays, 1),
        refreshIdleTimeoutDays: fromText(form.refreshIdleDays, 1),
      },
    })
  }

  const inherit = t`Default`
  return (
    <SettingsBlock
      id="sessions"
      onSubmit={submit}
      title={<Trans>Sessions and tokens</Trans>}
      description={
        <Trans>
          Defaults for every application. An application can set its own access token lifetime on
          its settings page; refresh token lifetimes always come from here.
        </Trans>
      }
    >
      <div {...stylex.props(styles.fieldGroup)}>
        <h3 {...stylex.props(settingsStyles.subTitle)}>
          <Trans>XID session</Trans>
        </h3>
        <UnitFields>
          <UnitField
            label={<Trans>Sign in again after</Trans>}
            unit={<Trans>days</Trans>}
            min={1}
            max={365}
            value={form.absoluteDays}
            placeholder={inherit}
            onChange={(value) => patch('absoluteDays', value)}
          />
          <UnitField
            label={<Trans>Or after no activity for</Trans>}
            unit={<Trans>days</Trans>}
            min={0.01}
            max={30}
            step={0.01}
            value={form.idleDays}
            placeholder={inherit}
            onChange={(value) => patch('idleDays', value)}
          />
        </UnitFields>
      </div>
      <div {...stylex.props(styles.fieldGroup)}>
        <h3 {...stylex.props(settingsStyles.subTitle)}>
          <Trans>Tokens issued to applications</Trans>
        </h3>
        <UnitFields>
          <UnitField
            label={<Trans>Access token</Trans>}
            unit={<Trans>minutes</Trans>}
            min={1}
            max={1440}
            value={form.accessMinutes}
            placeholder={inherit}
            onChange={(value) => patch('accessMinutes', value)}
          />
          <UnitField
            label={<Trans>Refresh token, absolute</Trans>}
            unit={<Trans>days</Trans>}
            min={1}
            max={90}
            value={form.refreshAbsoluteDays}
            placeholder={inherit}
            onChange={(value) => patch('refreshAbsoluteDays', value)}
          />
          <UnitField
            label={<Trans>Refresh token, idle</Trans>}
            unit={<Trans>days</Trans>}
            min={1}
            max={365}
            value={form.refreshIdleDays}
            placeholder={inherit}
            onChange={(value) => patch('refreshIdleDays', value)}
          />
        </UnitFields>
        <p {...stylex.props(settingsStyles.note)}>
          <Trans>
            Access tokens: 1 minute to 24 hours. Refresh tokens rotate on every use; reusing an old
            one signs out the whole chain. Leave a field empty to use the instance default.
          </Trans>
        </p>
      </div>
      <SaveButton isPending={isPending}>
        <Trans>Save sessions and tokens</Trans>
      </SaveButton>
      <SaveStatus error={error} saved={saved} />
    </SettingsBlock>
  )
}

export function SingleSignOnSection({
  orgId,
  policy,
  insights,
  orgName,
  connection,
}: SectionProps & { orgName: ReactNode; connection: SsoConnectionView | null }): ReactNode {
  const { t } = useLingui()
  const [forceSso, setForceSso] = useState(policy.hostedAuth.forceSso)
  const { save, saved, isPending, error } = useSectionSave(orgId)
  const routed = (insights?.routedDomains ?? []).filter((domain) => domain.verified)

  useEffect(() => setForceSso(policy.hostedAuth.forceSso), [policy.hostedAuth.forceSso])

  return (
    <SettingsBlock
      id="sso"
      onSubmit={() => save({ hostedAuth: { ...policy.hostedAuth, forceSso } })}
      title={<Trans>Require single sign-on</Trans>}
      description={
        <Trans>
          Turns off password sign-in for everyone in {orgName}. People sign in through the
          connection that matches their verified email domain.
        </Trans>
      }
      aside={
        <Switch
          label={<span {...stylex.props(page.visuallyHidden)}>{t`Require single sign-on`}</span>}
          checked={forceSso}
          onCheckedChange={setForceSso}
        />
      }
    >
      {routed.length > 0 && connection ? (
        <ul {...stylex.props(settingsStyles.rows)}>
          {routed.map((domain) => (
            <li key={domain.domain} {...stylex.props(styles.domainRow)}>
              <span {...stylex.props(styles.domain)}>{domain.domain}</span>
              <span {...stylex.props(styles.connection)}>{connection.name}</span>
              <span {...stylex.props(styles.people)}>
                <Plural value={domain.memberCount} one="# person" other="# people" />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p {...stylex.props(settingsStyles.note)}>
          <Trans>
            No verified domain is routed to an enterprise connection yet. Add the connection and
            verify a domain in Enterprise SSO first.
          </Trans>
        </p>
      )}
      <p {...stylex.props(settingsStyles.note)}>
        <Trans>
          Domains are routed in Enterprise SSO. Turn this on only after every active member has a
          routed domain, or they cannot sign in.
        </Trans>
      </p>
      <SaveButton isPending={isPending}>
        <Trans>Save single sign-on</Trans>
      </SaveButton>
      <SaveStatus error={error} saved={saved} />
    </SettingsBlock>
  )
}
