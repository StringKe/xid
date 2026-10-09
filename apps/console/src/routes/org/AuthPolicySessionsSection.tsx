// Sign-in & MFA 的「Sessions and tokens」分节:XID 会话与应用令牌有效期覆盖,留空回落实例默认。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { SaveButton, SettingsBlock, settingsStyles } from './AuthSettingsLayout'
import { SaveStatus, UnitField, UnitFields } from './AuthSettingsControls'
import { sectionStyles, useSectionSave } from './AuthPolicySections'
import type { SectionProps } from './AuthPolicySections'
import type { OrgAuthPolicyView } from './auth-queries'

const MINUTES_PER_DAY = 1440

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
      <div {...stylex.props(sectionStyles.fieldGroup)}>
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
      <div {...stylex.props(sectionStyles.fieldGroup)}>
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
