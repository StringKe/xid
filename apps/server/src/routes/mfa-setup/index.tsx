// 组织要求 MFA 而用户还没有可用因子时,在 Hosted Auth 内完成绑定,结束后续跑原来的 /authorize。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout, type AuthContextCopy } from '../../components/layout'
import { hosted } from '../../components/hosted/hosted-styles'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { useAuth } from '../../lib/auth-context'
import { useMfaResume } from '../mfa/use-mfa-resume'
import { browserSupportsWebAuthn } from '../sign-in/passkey'
import { BackupCodesStep } from './BackupCodesStep'
import { ChooseMethodStep } from './ChooseMethodStep'
import { PasskeySetupStep } from './PasskeySetupStep'
import { SetupSummaryStep } from './SetupSummaryStep'
import { TotpSetupStep } from './TotpSetupStep'
import { alternativeMethod, type SetupMethod, type SetupStep } from './setup-steps'

function useSetupContext(done: boolean): AuthContextCopy {
  const { t } = useLingui()
  const { config } = useHostedAuthConfig()
  const { applicationName: app, organizationName: org } = config.context
  if (done) {
    return {
      lead: t`Setup complete`,
      title: app ? t`Back to ${app}` : t`You're all set`,
      description: org
        ? t`You're signed in and your account now meets the ${org} policy.`
        : t`You're signed in and your account now meets your organization's policy.`,
    }
  }
  return {
    lead: app ? t`Before you continue to ${app}` : t`Before you continue`,
    title: org ? t`${org} requires a second step` : t`Your organization requires a second step`,
    description: t`Your admin turned this on for everyone. Setup takes about two minutes, then you'll go straight back.`,
    line: org ? t`${org} requires a second step` : undefined,
  }
}

function SwitchMethodLink(props: { to: SetupMethod; onSwitch: () => void }): ReactNode {
  return (
    <button type="button" onClick={props.onSwitch} {...stylex.props(hosted.textLink)}>
      {props.to === 'passkey' ? (
        <Trans>Set up a passkey instead</Trans>
      ) : (
        <Trans>Set up an authenticator app instead</Trans>
      )}
    </button>
  )
}

export default function MfaSetupPage(): ReactNode {
  const { refresh } = useAuth()
  const resume = useMfaResume()
  const { config } = useHostedAuthConfig()
  const passkeyAvailable = config.methods.passkey.enabled && browserSupportsWebAuthn()
  const [chosen, setSelected] = useState<SetupMethod | null>(null)
  const selected = chosen ?? (passkeyAvailable ? 'passkey' : 'totp')
  const [step, setStep] = useState<SetupStep>({ kind: 'choose' })
  const [continuing, setContinuing] = useState(false)
  const context = useSetupContext(step.kind === 'done')
  const { organizationName, applicationName } = config.context

  function alternativeFor(method: SetupMethod): ReactNode {
    const other = alternativeMethod(method, passkeyAvailable)
    if (!other) return null
    return (
      <SwitchMethodLink
        to={other}
        onSwitch={() => {
          setSelected(other)
          setStep({ kind: other })
        }}
      />
    )
  }

  async function finish(): Promise<void> {
    setContinuing(true)
    await refresh()
    resume()
  }

  return (
    <AuthLayout context={context}>
      {step.kind === 'choose' ? (
        <ChooseMethodStep
          organizationName={organizationName}
          passkeyAvailable={passkeyAvailable}
          selected={selected}
          onSelect={setSelected}
          onContinue={() => setStep({ kind: selected })}
        />
      ) : step.kind === 'totp' ? (
        <TotpSetupStep
          organizationName={organizationName}
          onActivated={() => setStep({ kind: 'backup', method: 'totp' })}
          alternative={alternativeFor('totp')}
        />
      ) : step.kind === 'passkey' ? (
        <PasskeySetupStep
          onRegistered={() => setStep({ kind: 'backup', method: 'passkey' })}
          alternative={alternativeFor('passkey')}
        />
      ) : step.kind === 'backup' ? (
        <BackupCodesStep
          organizationName={organizationName}
          onContinue={(count) =>
            setStep({ kind: 'done', method: step.method, backupCodeCount: count })
          }
        />
      ) : (
        <SetupSummaryStep
          method={step.method}
          backupCodeCount={step.backupCodeCount}
          organizationName={organizationName}
          applicationName={applicationName}
          isContinuing={continuing}
          onContinue={() => void finish()}
        />
      )}
    </AuthLayout>
  )
}
