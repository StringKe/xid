// CIBA backchannel 审批页(须登录);auth_req_id 查请求,approve/deny 走 /auth/ciba-activation。

import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import type { ApiErrorInput } from '@xid-kit/web-ui/api-errors'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { AuthLayout } from '../../components/layout'
import { Alert, Button, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { queryErrorInput } from '../../lib/query-error'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { styles as signInStyles } from '../sign-in/styles'
import { trackCibaActivationDecision } from '../../lib/google-analytics-funnel'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'

type CibaActivationParams = {
  authReqId: string
  clientId: string
  scope: string
  expiresAt: string
  firstParty: boolean
}

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  meta: {
    margin: 0,
    fontSize: '0.9375rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
})

function CibaActivationPage(): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
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

  const activationMutation = useMutation({
    mutationFn: (approved: boolean) =>
      api.post<{ approved: boolean }>('/auth/ciba-activation', {
        authReqId,
        approved,
      }),
    onSuccess: (result, approved) => {
      if (result.ok) trackCibaActivationDecision(approved)
    },
  })

  if (!authReqId) {
    return (
      <AuthLayout>
        <Alert tone="error" title={<Trans>Missing request</Trans>}>
          <Trans>Open this page from the CIBA authorization link that includes auth_req_id.</Trans>
        </Alert>
      </AuthLayout>
    )
  }

  if (activationMutation.isSuccess && activationMutation.data?.ok === true) {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)} aria-live="polite">
          <Alert tone="success" title={<Trans>Request handled</Trans>}>
            {activationMutation.data.value.approved
              ? t`The application can continue sign-in. You can close this page.`
              : t`The backchannel request was denied. You can close this page.`}
          </Alert>
          <Link to="/account" {...stylex.props(signInStyles.textLink)}>
            <Trans>Go to your account</Trans>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const cibaErrorMessage = (error: ApiErrorInput): string =>
    error.code === 'invalid_request'
      ? t`Backchannel request not found or expired.`
      : apiErrorMessage(error, { surface: 'general' })
  const queryError = cibaErrorMessage(queryErrorInput(paramsQuery.error))
  const submitError =
    activationMutation.isSuccess && activationMutation.data?.ok === false
      ? cibaErrorMessage(activationMutation.data.error)
      : null

  return (
    <AuthLayout>
      <div {...stylex.props(styles.stack)}>
        {paramsQuery.isPending ? (
          <div {...stylex.props(page.loadingCenter)} aria-live="polite">
            <Spinner label={t`Loading backchannel request`} />
          </div>
        ) : null}

        {paramsQuery.data ? (
          <>
            <p {...stylex.props(styles.meta)}>
              <Trans>
                Application <strong>{paramsQuery.data.clientId}</strong> is requesting sign-in
                approval.
              </Trans>
            </p>
            <p {...stylex.props(styles.meta)}>
              <Trans>Scopes: {paramsQuery.data.scope}</Trans>
            </p>
            <div {...stylex.props(styles.actions)}>
              <Button
                variant="accent"
                fullWidth
                disabled={activationMutation.isPending}
                onClick={() => void activationMutation.mutate(true)}
              >
                <Trans>Approve</Trans>
              </Button>
              <Button
                variant="secondary"
                fullWidth
                disabled={activationMutation.isPending}
                onClick={() => void activationMutation.mutate(false)}
              >
                <Trans>Deny</Trans>
              </Button>
            </div>
          </>
        ) : null}

        {paramsQuery.isError ? <Alert tone="error">{queryError}</Alert> : null}
        {submitError ? <Alert tone="error">{submitError}</Alert> : null}
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/ciba-activation')({
  component: CibaActivationPage,
})

export default CibaActivationPage
