// CIBA 审批页(须登录):只画应用名、批准后对方拿到什么与到期时间;binding_message 未实现,不显示核对码。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import type { ApiErrorInput } from '@xid-kit/web-ui/api-errors'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { AuthLayout, type AuthContextCopy } from '../../components/layout'
import { Button, Notice, Spinner } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { AccountChip } from '../../components/hosted/IdentityChip'
import { hosted } from '../../components/hosted/hosted-styles'
import { RequestCard } from '../../components/hosted/RequestCard'
import { useAuth } from '../../lib/auth-context'
import { queryErrorInput } from '../../lib/query-error'
import { trackCibaActivationDecision } from '../../lib/google-analytics-funnel'
import { page } from '../../styles/product-surface.stylex'
import { formatCountdown } from '../sign-in/otp-timing'

type CibaActivationParams = {
  authReqId: string
  clientId: string
  clientName: string
  clientLogoUrl: string | null
  scope: string
  expiresAt: string
  firstParty: boolean
}

function useSecondsLeft(expiresAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (!expiresAt) return 0
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000))
}

function useCibaContext(app: string | null, outcome: boolean | null): AuthContextCopy {
  const { t } = useLingui()
  const title = app ?? t`An app`
  if (outcome === true)
    return {
      lead: t`Sign-in approved`,
      title,
      description: t`The app can finish signing you in on the other device.`,
    }
  if (outcome === false)
    return {
      lead: t`Sign-in denied`,
      title,
      description: t`Nothing was shared. The app will be told you said no.`,
    }
  return {
    lead: t`Sign-in request from`,
    title,
    description: t`An app is asking you to approve a sign-in it started. Nothing happens until you choose.`,
  }
}

function CibaActivationPage(): ReactNode {
  const { t } = useLingui()
  const { api, user } = useAuth()
  const apiErrorMessage = useApiErrorMessage()
  const search = useSearch({ strict: false }) as { auth_req_id?: string }
  const authReqId = useMemo(() => search.auth_req_id?.trim() ?? '', [search.auth_req_id])

  const paramsQuery = useQuery({
    queryKey: ['ciba-activation', authReqId],
    enabled: Boolean(authReqId),
    retry: false,
    staleTime: 0,
    queryFn: async (): Promise<CibaActivationParams> => {
      const result = await api.get<CibaActivationParams>('/auth/ciba-activation', {
        query: { auth_req_id: authReqId },
      })
      if (!result.ok) throw result.error
      return result.value
    },
  })

  const decision = useMutation({
    mutationFn: (approved: boolean) =>
      api.post<{ approved: boolean }>('/auth/ciba-activation', { authReqId, approved }),
    onSuccess: (result, approved) => {
      if (result.ok) trackCibaActivationDecision(approved)
    },
  })

  const params = paramsQuery.data
  const outcome = decision.data?.ok === true ? decision.data.value.approved : null
  const context = useCibaContext(params?.clientName ?? null, outcome)
  const secondsLeft = useSecondsLeft(params?.expiresAt)
  const above = user?.email ? <AccountChip label={user.email} /> : undefined
  const describe = (error: ApiErrorInput): string =>
    error.code === 'invalid_request'
      ? t`This request expired or was already answered. Start again from the app.`
      : apiErrorMessage(error, { surface: 'general' })

  function content(): ReactNode {
    if (!authReqId || paramsQuery.isError) {
      return (
        <AuthHeading
          above={above}
          title={<Trans>This request can't be approved</Trans>}
          lead={
            authReqId
              ? describe(queryErrorInput(paramsQuery.error))
              : t`Open this page from the link the app gave you.`
          }
        />
      )
    }
    if (!params) {
      return (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Loading the sign-in request`} />
        </div>
      )
    }
    const app = params.clientName
    if (outcome !== null) {
      return (
        <AuthHeading
          above={above}
          title={outcome ? <Trans>You approved {app}</Trans> : <Trans>You denied {app}</Trans>}
          lead={<Trans>You can close this tab.</Trans>}
        />
      )
    }
    const countdown = formatCountdown(secondsLeft)
    return (
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          above={above}
          title={<Trans>Approve sign-in for {app}?</Trans>}
          lead={
            <Trans>
              {app} started a sign-in for your account from another device. Approve only if you
              asked for this.
            </Trans>
          }
        />
        <RequestCard
          clientName={app}
          clientId={params.clientId}
          firstParty={params.firstParty}
          scopes={params.scope.split(' ').filter(Boolean)}
          heading={<Trans>If you approve, {app} gets</Trans>}
        />
        {decision.data && !decision.data.ok ? (
          <Notice tone="danger">{describe(decision.data.error)}</Notice>
        ) : null}
        <div {...stylex.props(hosted.actions)}>
          <Button
            variant="accent"
            size="lg"
            fullWidth
            isLoading={decision.isPending}
            onClick={() => decision.mutate(true)}
          >
            <Trans>Approve</Trans>
          </Button>
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            disabled={decision.isPending}
            onClick={() => decision.mutate(false)}
          >
            <Trans>Deny</Trans>
          </Button>
        </div>
        <p {...stylex.props(hosted.note, hosted.tabular)}>
          <Trans>
            This request expires in {countdown}. If you didn't start it, choose Deny. Nothing is
            shared.
          </Trans>
        </p>
      </div>
    )
  }

  return <AuthLayout context={context}>{content()}</AuthLayout>
}

export const Route = createLazyRoute('/ciba-activation')({
  component: CibaActivationPage,
})

export default CibaActivationPage
