// Sign-in & MFA 的「Sign-up and identifiers」分节:标识方式、邮箱域名规则、注册字段、passkey 证明与企业 SSO 开关。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Field, Input, Select } from '@xid-kit/web-ui/ui'
import { SaveButton, SettingsBlock, settingsStyles } from './AuthSettingsLayout'
import { SaveStatus, SwitchRows } from './AuthSettingsControls'
import { useSaveOrgAuthPolicy } from './auth-queries'
import type { OrgAuthPolicyView } from './auth-queries'
import type { HostedAuthPolicy, HostedAuthProfileFields, ProfileFieldMode } from './types'

const styles = stylex.create({
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 36rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '0.75rem 1rem',
  },
})

const PROFILE_FIELDS = ['email', 'username', 'phone', 'name', 'givenName', 'familyName'] as const

function listToText(value: readonly string[]): string {
  return value.join(', ')
}

function textToList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export function SignUpSection({
  orgId,
  policy,
}: {
  orgId: string
  policy: OrgAuthPolicyView
}): ReactNode {
  const { t } = useLingui()
  const [form, setForm] = useState<HostedAuthPolicy>(policy.hostedAuth)
  const [saved, setSaved] = useState(false)
  const mutation = useSaveOrgAuthPolicy(orgId)

  useEffect(() => setForm(policy.hostedAuth), [policy.hostedAuth])

  function patch<K extends keyof HostedAuthPolicy>(key: K, value: HostedAuthPolicy[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function patchSso(key: keyof HostedAuthPolicy['enterpriseSso'], value: boolean): void {
    setForm((prev) => ({ ...prev, enterpriseSso: { ...prev.enterpriseSso, [key]: value } }))
  }

  function patchProfile(key: keyof HostedAuthProfileFields, value: ProfileFieldMode): void {
    setForm((prev) => ({ ...prev, profileFields: { ...prev.profileFields, [key]: value } }))
  }

  function submit(): void {
    setSaved(false)
    const current = policy.hostedAuth
    mutation.mutate(
      {
        hostedAuth: {
          ...current,
          identifierMode: form.identifierMode,
          allowedEmailDomains: form.allowedEmailDomains,
          blockedEmailDomains: form.blockedEmailDomains,
          allowExistingUserLogin: form.allowExistingUserLogin,
          allowUserCreation: form.allowUserCreation,
          requireVerifiedEmail: form.requireVerifiedEmail,
          profileFields: form.profileFields,
          attestationMode: form.attestationMode,
          enterpriseSso: form.enterpriseSso,
        },
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  const profileLabels: Record<(typeof PROFILE_FIELDS)[number], string> = {
    email: t`Email`,
    username: t`Username`,
    phone: t`Phone number`,
    name: t`Name`,
    givenName: t`First name`,
    familyName: t`Last name`,
  }

  return (
    <SettingsBlock
      id="sign-up"
      onSubmit={submit}
      title={<Trans>Sign-up and identifiers</Trans>}
      description={
        <Trans>
          What people type to sign in, who can create an account, and what the sign-up form asks
          for.
        </Trans>
      }
    >
      <div {...stylex.props(styles.grid)}>
        <Field label={<Trans>People sign in with</Trans>}>
          <Select
            value={form.identifierMode}
            onChange={(event) =>
              patch('identifierMode', event.target.value as HostedAuthPolicy['identifierMode'])
            }
          >
            <option value="email">{t`Email address`}</option>
            <option value="username">{t`Username`}</option>
            <option value="email_or_username">{t`Email address or username`}</option>
            <option value="phone">{t`Phone number`}</option>
            <option value="external_id">{t`External ID`}</option>
          </Select>
        </Field>
        <Field label={<Trans>Passkey attestation</Trans>}>
          <Select
            value={form.attestationMode ?? 'none'}
            onChange={(event) =>
              patch('attestationMode', event.target.value as HostedAuthPolicy['attestationMode'])
            }
          >
            <option value="none">{t`Not required`}</option>
            <option value="indirect">{t`Indirect`}</option>
            <option value="direct">{t`Direct, checked against trusted roots`}</option>
          </Select>
        </Field>
        <Field label={<Trans>Only allow these email domains</Trans>}>
          <Input
            value={listToText(form.allowedEmailDomains)}
            placeholder={t`Any domain`}
            onChange={(event) => patch('allowedEmailDomains', textToList(event.target.value))}
          />
        </Field>
        <Field label={<Trans>Block these email domains</Trans>}>
          <Input
            value={listToText(form.blockedEmailDomains)}
            placeholder={t`None`}
            onChange={(event) => patch('blockedEmailDomains', textToList(event.target.value))}
          />
        </Field>
      </div>
      <SwitchRows
        rows={[
          {
            key: 'existing',
            label: <Trans>Existing people can sign in</Trans>,
            description: (
              <Trans>Turn off to pause Hosted Auth sign-in for this organization.</Trans>
            ),
            checked: form.allowExistingUserLogin,
            onChange: (value) => patch('allowExistingUserLogin', value),
          },
          {
            key: 'create',
            label: <Trans>New people can create an account</Trans>,
            description: <Trans>Turn off to accept only invited people.</Trans>,
            checked: form.allowUserCreation,
            onChange: (value) => patch('allowUserCreation', value),
          },
          {
            key: 'verified',
            label: <Trans>Require a verified email</Trans>,
            description: <Trans>People confirm their email address before they continue.</Trans>,
            checked: form.requireVerifiedEmail,
            onChange: (value) => patch('requireVerifiedEmail', value),
          },
          {
            key: 'sso',
            label: <Trans>Enterprise SSO sign-in</Trans>,
            description: (
              <Trans>People can sign in through the connection in Enterprise SSO.</Trans>
            ),
            checked: form.enterpriseSso.enabled && form.enterpriseSso.allowLogin,
            onChange: (value) => {
              patchSso('enabled', value)
              patchSso('allowLogin', value)
            },
          },
          {
            key: 'jit',
            label: <Trans>Create accounts on first enterprise sign-in</Trans>,
            description: <Trans>People from a routed domain get an account the first time.</Trans>,
            checked: form.enterpriseSso.allowJitUserCreation,
            onChange: (value) => patchSso('allowJitUserCreation', value),
          },
          {
            key: 'discovery',
            label: <Trans>Send routed domains straight to their provider</Trans>,
            description: (
              <Trans>Hosted Auth checks the email domain before asking for a password.</Trans>
            ),
            checked: form.enterpriseSso.domainDiscovery,
            onChange: (value) => patchSso('domainDiscovery', value),
          },
        ]}
      />
      <div {...stylex.props(styles.group)}>
        <h3 {...stylex.props(settingsStyles.subTitle)}>
          <Trans>Sign-up form</Trans>
        </h3>
        <div {...stylex.props(styles.grid)}>
          {PROFILE_FIELDS.map((field) => (
            <Field key={field} label={profileLabels[field]}>
              <Select
                value={form.profileFields[field]}
                onChange={(event) => patchProfile(field, event.target.value as ProfileFieldMode)}
              >
                <option value="required">{t`Required`}</option>
                <option value="optional">{t`Optional`}</option>
                <option value="hidden">{t`Not asked`}</option>
              </Select>
            </Field>
          ))}
        </div>
      </div>
      <SaveButton isPending={mutation.isPending}>
        <Trans>Save sign-up settings</Trans>
      </SaveButton>
      <SaveStatus error={mutation.error} saved={saved} />
    </SettingsBlock>
  )
}
