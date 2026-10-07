// 登录后的可选步骤:没有 passkey 的用户先尝试浏览器的 Conditional Create,失败或不支持再显示插页。
// 不符合条件、选「Not now」或创建完成后都续跑原落点。

import { useLingui } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { normalizeLocalPath, type XidError } from '@xid-kit/types'
import { AuthLayout } from '../../components/layout'
import { Spinner } from '../../components/ui'
import { useDefaultPasskeyName } from '../../components/hosted/passkey-name'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { useAuth } from '../../lib/auth-context'
import { useDefaultLandingPath } from '../../lib/default-landing'
import { trackPasskeyRegistered } from '../../lib/google-analytics-funnel'
import { page } from '../../styles/product-surface.stylex'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { usePasskeysQuery, useRegisterPasskey } from '../account/queries'
import { browserStorage } from '../sign-in/method-order'
import { browserSupportsWebAuthn } from '../sign-in/passkey'
import { CancelledView, CreatedView, OfferView, StepUpView } from './PromptViews'
import {
  readPromptDismissed,
  shouldOfferPasskey,
  supportsConditionalCreate,
  writePromptDismissed,
} from './passkey-prompt'

type View = 'offer' | 'cancelled' | 'step-up' | 'created'

function serverEligibility(user: unknown): boolean | undefined {
  if (typeof user !== 'object' || user === null) return undefined
  const value = (user as { passkeyEnrollmentEligible?: unknown }).passkeyEnrollmentEligible
  return typeof value === 'boolean' ? value : undefined
}

export default function CreatePasskeyPage(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const navigate = useNavigate()
  const fallback = useDefaultLandingPath()
  const search = useSearch({ strict: false }) as { redirect_to?: string }
  const target = normalizeLocalPath(search.redirect_to) ?? fallback
  const { config, isPending: configPending } = useHostedAuthConfig()
  const passkeys = usePasskeysQuery()
  const register = useRegisterPasskey()
  const conditional = useRegisterPasskey()
  const deviceName = useDefaultPasskeyName()
  const [view, setView] = useState<View>('offer')
  const conditionalAbort = useRef<AbortController | null>(null)
  const appName = config.context.applicationName
  const eligibility = configPending
    ? 'unknown'
    : shouldOfferPasskey({
        serverEligible: serverEligibility(user),
        passkeyCount: passkeys.data?.data.length ?? (passkeys.isError ? 1 : undefined),
        passkeyMethodEnabled: config.methods.passkey.enabled,
        browserSupportsPasskeys: browserSupportsWebAuthn(),
        dismissed: readPromptDismissed(browserStorage()),
      })

  function proceed(): void {
    navigate(target, { replace: true })
  }

  function onCreated(): void {
    trackPasskeyRegistered()
    setView('created')
  }

  function onFailed(error: unknown): void {
    setView((error as XidError | undefined)?.code === 'step_up_required' ? 'step-up' : 'cancelled')
  }

  useEffect(() => {
    if (eligibility === false && view === 'offer') navigate(target, { replace: true })
  }, [eligibility, navigate, target, view])

  // 浏览器支持时先静默提议保存,用户不必再点一次;失败保持插页,不打扰。
  useEffect(() => {
    if (eligibility !== true || conditionalAbort.current) return
    const controller = new AbortController()
    conditionalAbort.current = controller
    void supportsConditionalCreate().then((supported) => {
      if (!supported || controller.signal.aborted) return
      conditional.mutate(
        { deviceName, mediation: 'conditional', signal: controller.signal },
        { onSuccess: onCreated },
      )
    })
  })

  useEffect(() => () => conditionalAbort.current?.abort(), [])

  function create(): void {
    conditionalAbort.current?.abort()
    register.mutate({ deviceName }, { onSuccess: onCreated, onError: onFailed })
  }

  function notNow(): void {
    writePromptDismissed(browserStorage(), Date.now())
    proceed()
  }

  function verifyFirst(): void {
    const back = `/create-passkey?${new URLSearchParams({ redirect_to: target }).toString()}`
    navigate(`/mfa?${new URLSearchParams({ step_up: '1', redirect_to: back }).toString()}`)
  }

  const context = {
    lead: t`You're signed in to`,
    title: appName ?? config.context.organizationName ?? t`your account`,
    description: appName
      ? t`One optional step before ${appName} opens.`
      : t`One optional step before you continue.`,
  }
  const host = typeof window === 'undefined' ? '' : window.location.hostname

  return (
    <AuthLayout context={context}>
      {eligibility !== true && view === 'offer' ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Continuing`} />
        </div>
      ) : view === 'created' ? (
        <CreatedView appName={appName} onContinue={proceed} />
      ) : view === 'step-up' ? (
        <StepUpView onVerify={verifyFirst} onNotNow={notNow} />
      ) : view === 'cancelled' ? (
        <CancelledView
          appName={appName}
          isCreating={register.isPending}
          onCreate={create}
          onNotNow={notNow}
        />
      ) : (
        <OfferView
          account={user?.email ?? null}
          host={host}
          isCreating={register.isPending}
          onCreate={create}
          onNotNow={notNow}
        />
      )}
    </AuthLayout>
  )
}
