// /consent:OIDC 授权同意页。设计真相源:docs/design/03-oidc-oauth.md 第 6 节。
// GET /auth/consent-params 拉展示参数,POST /auth/consent {prompt_id, approved} 提交。

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

// Worker GET /auth/consent-params 的响应契约。
export type ConsentParams = {
  clientId: string
  clientName: string
  clientLogoUrl: string | null
  // scope 列表,每条带 name(机器名)与 description(人类可读,后端已本地化)。
  scopes: readonly { name: string; description: string }[]
  authorizationDetails: readonly {
    type: 'resource_access'
    locations: readonly string[]
    actions: readonly string[]
  }[]
  // 本次是否为 first-party app(first-party 通常静默通过,但 prompt=consent 强制显示)。
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

  // 拉取 consent 展示参数。
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
      <Alert tone="error" title={<Trans>Authorization failed</Trans>}>
        {errorMessage}
      </Alert>
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

// TanStack Router lazy 路由。
export const Route = createLazyRoute('/consent')({
  component: ConsentPage,
})

// default export 供 router.tsx protectedRoute 工厂使用(RequireAuth 守卫注入)。
export default ConsentPage
