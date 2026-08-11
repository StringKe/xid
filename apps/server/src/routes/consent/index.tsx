// OIDC 同意页:GET /auth/consent-params,POST /auth/consent {prompt_id, approved}。

import { Trans, useLingui } from '@lingui/react/macro'
import { useId } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { page } from '../../styles/product-surface.stylex'
import { Alert, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useAuth } from '../../lib/auth-context'
import { Link } from '../../lib/router'
import { trackConsentDecision } from '../../lib/google-analytics-funnel'
import { styles as signInStyles } from '../sign-in/styles'
import { ClientHeader } from './ClientHeader'
import { ScopeList, AuthorizationDetailsList } from './ScopeList'
import { ConsentActions } from './ConsentActions'

export type ConsentParams = {
  clientId: string
  clientName: string
  clientLogoUrl: string | null
  scopes: readonly { name: string; description: string }[]
  authorizationDetails: readonly {
    type: 'resource_access'
    locations: readonly string[]
    actions: readonly string[]
  }[]
  // first-party 通常静默;prompt=consent 仍强制显示。
  firstParty: boolean
}

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  doneWrapper: {
    textAlign: 'center',
    paddingBlock: '1rem',
    fontSize: '0.875rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
})

function ConsentPage(): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const search = useSearch({ strict: false }) as {
    prompt_id?: string
    authz_request_id?: string
  }
  const promptId = search.prompt_id ?? search.authz_request_id ?? ''
  const titleId = useId()

  const paramsQuery = useQuery({
    queryKey: ['consent-params', promptId],
    enabled: Boolean(promptId),
    retry: false,
    staleTime: Infinity,
    queryFn: async (): Promise<ConsentParams> => {
      const result = await api.get<ConsentParams>('/auth/consent-params', {
        query: { prompt_id: promptId },
      })
      if (!result.ok) throw result.error
      return result.value
    },
  })

  const consentMutation = useMutation({
    mutationFn: (approved: boolean) =>
      api.post<{ redirectUrl: string }>('/auth/consent', { promptId, approved }),
    onSuccess: (result, approved) => {
      if (result.ok) {
        trackConsentDecision(approved)
        globalThis.location.href = result.value.redirectUrl
      }
    },
  })

  if (!promptId) {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <Alert tone="error" title={<Trans>Authorization failed</Trans>}>
            {t`Authorization request is missing or has expired.`}
          </Alert>
          <Link to="/sign-in" {...stylex.props(signInStyles.textLink)}>
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <ConsentContent
        isPending={paramsQuery.isPending}
        isError={paramsQuery.isError}
        errorMessage={
          paramsQuery.error &&
          typeof paramsQuery.error === 'object' &&
          'longMessage' in paramsQuery.error
            ? ((paramsQuery.error as { longMessage?: string; message?: string }).longMessage ??
              (paramsQuery.error as { message?: string }).message ??
              t`Authorization failed.`)
            : t`Authorization failed.`
        }
        params={paramsQuery.data ?? null}
        isSubmitting={consentMutation.isPending}
        isDone={consentMutation.isSuccess && consentMutation.data?.ok === true}
        submitError={
          consentMutation.isSuccess && !consentMutation.data?.ok
            ? (consentMutation.data?.error?.longMessage ??
              consentMutation.data?.error?.message ??
              null)
            : null
        }
        titleId={titleId}
        onAllow={() => void consentMutation.mutate(true)}
        onDeny={() => void consentMutation.mutate(false)}
      />
    </AuthLayout>
  )
}

type ConsentContentProps = {
  isPending: boolean
  isError: boolean
  errorMessage: string
  params: ConsentParams | null
  isSubmitting: boolean
  isDone: boolean
  submitError: string | null
  titleId: string
  onAllow: () => void
  onDeny: () => void
}

function ConsentContent({
  isPending,
  isError,
  errorMessage,
  params,
  isSubmitting,
  isDone,
  submitError,
  titleId,
  onAllow,
  onDeny,
}: ConsentContentProps): ReactNode {
  const { t } = useLingui()

  if (isPending) {
    return (
      <div {...stylex.props(page.loadingCenter)} aria-live="polite">
        <Spinner label={t`Loading authorization details`} />
      </div>
    )
  }

  if (isError) {
    return (
      <div {...stylex.props(styles.stack)}>
        <Alert tone="error" title={<Trans>Authorization failed</Trans>}>
          {errorMessage}
        </Alert>
        <Link to="/sign-in" {...stylex.props(signInStyles.textLink)}>
          <Trans>Back to sign in</Trans>
        </Link>
      </div>
    )
  }

  if (isDone) {
    return (
      <div {...stylex.props(styles.doneWrapper)} aria-live="polite">
        <Trans>Redirecting...</Trans>
      </div>
    )
  }

  if (!params) return null

  return (
    <section aria-labelledby={titleId} {...stylex.props(styles.stack)}>
      <ClientHeader params={params} titleId={titleId} />
      <ScopeList scopes={params.scopes} />
      <AuthorizationDetailsList details={params.authorizationDetails} />
      {submitError ? (
        <Alert tone="error" title={<Trans>Authorization failed</Trans>}>
          {submitError}
        </Alert>
      ) : null}
      <ConsentActions isSubmitting={isSubmitting} onAllow={onAllow} onDeny={onDeny} />
    </section>
  )
}

export const Route = createLazyRoute('/consent')({
  component: ConsentPage,
})

export default ConsentPage
