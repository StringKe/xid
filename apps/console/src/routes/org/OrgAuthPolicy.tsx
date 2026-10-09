import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, ConsolePage, ConsolePageNotice, Spinner } from '@xid-kit/web-ui/ui'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { useOrgSelfServiceLocked, useOrgTarget } from './useOrgTarget'
import { LockableFieldset, SelfServiceLockNotice } from './SelfServiceLock'
import { SettingsSections } from './AuthSettingsLayout'
import type { SettingsSectionLink } from './AuthSettingsLayout'
import {
  SessionsSection,
  SignInMethodsSection,
  SingleSignOnSection,
  TwoStepSection,
} from './AuthPolicySections'
import { SignUpSection } from './AuthPolicySignUpSection'
import { useOrgAuthInsights, useOrgAuthPolicyView, useOrgSsoConnectionsView } from './auth-queries'
import type { AuthPolicyInsights, OrgAuthPolicyView } from './auth-queries'

function useSectionLinks(
  policy: OrgAuthPolicyView | undefined,
  insights: AuthPolicyInsights | undefined,
): SettingsSectionLink[] {
  const { t } = useLingui()
  const hosted = policy?.hostedAuth
  const methods = hosted
    ? [
        hosted.passkey.enabled ? t`Passkeys` : null,
        hosted.password.enabled ? t`password` : null,
        hosted.emailOtp.enabled ? t`email code` : null,
        hosted.magicLink.enabled ? t`magic link` : null,
        hosted.smsOtp.enabled || hosted.whatsappOtp.enabled ? t`SMS and WhatsApp` : null,
      ].filter((name): name is string => name !== null)
    : []
  const mfa = policy?.effectiveMfaPolicy
  const notSetUp = insights?.usersWithoutSecondFactor ?? 0
  const absoluteDays = policy?.sessionPolicy.absoluteTimeoutDays ?? null
  return [
    {
      id: 'methods',
      title: <Trans>Sign-in methods</Trans>,
      summary: methods.length > 0 ? methods.join(', ') : <Trans>No method turned on</Trans>,
    },
    {
      id: 'two-step',
      title: <Trans>Two-step verification</Trans>,
      summary:
        mfa === 'required' ? (
          <Trans>Required for everyone, {notSetUp} not set up yet</Trans>
        ) : mfa === 'optional' ? (
          <Trans>Optional</Trans>
        ) : (
          <Trans>Off</Trans>
        ),
    },
    {
      id: 'sessions',
      title: <Trans>Sessions and tokens</Trans>,
      summary:
        absoluteDays === null ? (
          <Trans>Instance defaults</Trans>
        ) : (
          <Trans>Sign in again after {absoluteDays} days</Trans>
        ),
    },
    {
      id: 'sso',
      title: <Trans>Single sign-on</Trans>,
      summary: hosted?.forceSso ? (
        <Trans>Required, password sign-in is off</Trans>
      ) : (
        <Trans>Not required</Trans>
      ),
    },
    {
      id: 'sign-up',
      title: <Trans>Sign-up and identifiers</Trans>,
      summary: hosted?.allowUserCreation ? (
        <Trans>New accounts allowed</Trans>
      ) : (
        <Trans>Invitation only</Trans>
      ),
    },
  ]
}

export default function OrgAuthPolicyPage(): ReactNode {
  const { t } = useLingui()
  const locked = useOrgSelfServiceLocked()
  const { orgId, orgName } = useOrgTarget()
  const { data: policy, isLoading, isError } = useOrgAuthPolicyView(orgId)
  const { data: insights } = useOrgAuthInsights(orgId)
  const { data: connections } = useOrgSsoConnectionsView(orgId)
  const sections = useSectionLinks(policy, insights)
  const title = <Trans>Sign-in &amp; MFA</Trans>

  if (!orgId) {
    return (
      <ConsolePage title={title}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage
      title={title}
      lead={
        <Trans>
          How people prove who they are when they sign in to any {orgName} app. Each section saves
          on its own.
        </Trans>
      }
    >
      {locked || isError ? (
        <ConsolePageNotice>
          {locked ? <SelfServiceLockNotice /> : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Sign-in settings could not be loaded. Reload the page to try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}
      {!policy ? (
        isLoading ? (
          <div {...stylex.props(consoleShell.sectionPad)}>
            <Spinner label={t`Loading sign-in settings`} />
          </div>
        ) : null
      ) : (
        <LockableFieldset locked={locked}>
          <SettingsSections sections={sections} backLabel={title}>
            <SignInMethodsSection orgId={orgId} policy={policy} insights={insights} />
            <TwoStepSection orgId={orgId} policy={policy} insights={insights} />
            <SessionsSection orgId={orgId} policy={policy} insights={insights} />
            <SingleSignOnSection
              orgId={orgId}
              policy={policy}
              insights={insights}
              orgName={orgName}
              connection={connections?.[0] ?? null}
            />
            <SignUpSection orgId={orgId} policy={policy} />
          </SettingsSections>
        </LockableFieldset>
      )}
    </ConsolePage>
  )
}
