// MFA 挑战:登录后服务端已确认身份,这里可以按用户实际拥有的因子渲染;step-up 不列短信。

import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice, Spinner } from '../../components/ui'
import { AuthLayout, type AuthContextCopy } from '../../components/layout'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { useContinueLine } from '../../components/hosted/context-copy'
import { AccountChip } from '../../components/hosted/IdentityChip'
import { hosted } from '../../components/hosted/hosted-styles'
import { OptionList, type OptionItem } from '../../components/hosted/OptionList'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { useAuth } from '../../lib/auth-context'
import { page } from '../../styles/product-surface.stylex'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { useMfaFactorsQuery } from '../account/queries'
import type { MfaFactor } from '../account/types'
import { browserStorage } from '../sign-in/method-order'
import { BackupCodeChallenge, SmsOtpChallenge, TotpChallenge } from './CodeChallenges'
import { ChallengeExits } from './MfaExits'
import {
  availableFactorMethods,
  defaultMfaMethod,
  isMfaMethod,
  MFA_CHOOSER,
  mfaMethodSearch,
  readLastMfaMethod,
  type MfaMethod,
  type MfaSearch,
} from './mfa-search'
import { PasskeyMfaChallenge } from './PasskeyMfaChallenge'

function useMfaContext(isStepUp: boolean): AuthContextCopy | undefined {
  const { t } = useLingui()
  const { config } = useHostedAuthConfig()
  const { applicationName: app, organizationName: org } = config.context
  const line = useContinueLine()
  if (isStepUp) {
    return {
      lead: t`Before you continue`,
      title: t`Confirm it's you`,
      description: t`Changing how you sign in needs a fresh check. Once you verify, you won't be asked again for 5 minutes.`,
    }
  }
  if (!app && !org) return undefined
  return {
    lead: app ? t`You are signing in to continue to` : t`You are signing in to`,
    title: app ?? org ?? '',
    description: org
      ? t`${org} asks for a second step every time you sign in.`
      : t`Your organization asks for a second step every time you sign in.`,
    line,
  }
}

function MethodChooser(props: {
  methods: readonly MfaMethod[]
  factors: readonly MfaFactor[]
  lastUsed: MfaMethod | null
  isStepUp: boolean
  above: ReactNode
}): ReactNode {
  const { t } = useLingui()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as MfaSearch
  const { config } = useHostedAuthConfig()
  const org = config.context.organizationName
  const backup = props.factors.find((factor) => factor.type === 'backup_codes')
  const remaining = backup?.type === 'backup_codes' ? backup.remaining : 0
  const copy: Record<MfaMethod, Omit<OptionItem, 'key' | 'onSelect'>> = {
    passkey: {
      title: <Trans>Use a passkey</Trans>,
      description: <Trans>Face ID, fingerprint or a security key</Trans>,
      icon: 'passkey',
    },
    totp: {
      title: <Trans>Authenticator app</Trans>,
      description: <Trans>6-digit code from your app</Trans>,
      icon: 'smartphone',
    },
    sms: {
      title: <Trans>Text message</Trans>,
      description: <Trans>Send a code to your phone</Trans>,
      icon: 'message',
    },
    backup: {
      title: <Trans>Backup code</Trans>,
      description: <Trans>{remaining} codes left</Trans>,
      icon: 'file-text',
    },
  }
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>Choose another way to verify</Trans>}
        lead={
          org ? (
            <Trans>These are the methods on your account that {org} accepts.</Trans>
          ) : (
            <Trans>These are the methods on your account.</Trans>
          )
        }
      />
      <OptionList
        variant="boxed"
        label={t`Verification methods`}
        items={props.methods.map((method) => ({
          key: method,
          ...copy[method],
          badge:
            method === props.lastUsed && props.methods.length > 1 ? (
              <Trans>Last used</Trans>
            ) : undefined,
          onSelect: () => navigate(`/mfa${mfaMethodSearch(method, search)}`, { replace: true }),
        }))}
      />
      <div {...stylex.props(hosted.group)}>
        <p {...stylex.props(hosted.note, hosted.noteStrong)}>
          <Trans>Can't use any of these?</Trans>
        </p>
        <p {...stylex.props(hosted.note)}>
          {org ? (
            <Trans>
              Ask a {org} admin to reset your two-step verification. They will need to confirm who
              you are.
            </Trans>
          ) : (
            <Trans>
              Ask your admin to reset your two-step verification. They will need to confirm who you
              are.
            </Trans>
          )}
        </p>
      </div>
      <ChallengeExits methods={[]} isStepUp={props.isStepUp} />
    </div>
  )
}

function MfaChallenge(props: {
  method: MfaMethod
  isStepUp: boolean
  methods: readonly MfaMethod[]
  above: ReactNode
}): ReactNode {
  const { method, ...challengeProps } = props
  if (method === 'totp') return <TotpChallenge {...challengeProps} />
  if (method === 'backup') return <BackupCodeChallenge {...challengeProps} />
  if (method === 'passkey') return <PasskeyMfaChallenge {...challengeProps} />
  return <SmsOtpChallenge {...challengeProps} />
}

function MfaPage(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const search = useSearch({ strict: false }) as MfaSearch
  const { data: factors, isPending, error, refetch, isRefetching } = useMfaFactorsQuery()
  const isStepUp = search.step_up === '1'
  const lastUsed = useMemo(() => readLastMfaMethod(browserStorage()), [])
  const methods = factors ? availableFactorMethods(factors, { stepUp: isStepUp }) : []
  const requested = isMfaMethod(search.method ?? null) ? (search.method as MfaMethod) : null
  const selected = requested && methods.includes(requested) ? requested : null
  const choosing = search.method === MFA_CHOOSER && methods.length > 1
  const activeMethod = selected ?? (choosing ? null : defaultMfaMethod(methods, lastUsed))
  const context = useMfaContext(isStepUp)
  const above = user?.email ? <AccountChip label={user.email} name={user.name} /> : undefined

  return (
    <AuthLayout context={context}>
      {isPending ? (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Loading verification methods`} />
        </div>
      ) : error ? (
        <div {...stylex.props(hosted.screen)}>
          <AuthHeading title={<Trans>We couldn't load your verification methods</Trans>} />
          <Notice tone="danger">
            <Trans>Check your connection and try again.</Trans>
          </Notice>
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            isLoading={isRefetching}
            onClick={() => void refetch()}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : activeMethod ? (
        <MfaChallenge
          key={activeMethod}
          method={activeMethod}
          isStepUp={isStepUp}
          methods={methods}
          above={above}
        />
      ) : methods.length > 0 ? (
        <MethodChooser
          methods={methods}
          factors={factors ?? []}
          lastUsed={lastUsed}
          isStepUp={isStepUp}
          above={above}
        />
      ) : (
        <div {...stylex.props(hosted.screen)}>
          <AuthHeading
            title={<Trans>No way to verify on this account</Trans>}
            lead={
              <Trans>
                Sign out, then sign in another way or ask your admin to reset two-step verification.
              </Trans>
            }
          />
          <ChallengeExits methods={[]} isStepUp={false} />
        </div>
      )}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/mfa')({
  component: MfaPage,
})
