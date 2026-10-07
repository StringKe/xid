// OIDC 同意页:写清跳转去向、是否第一方、应用归属组织;再次授权只列新增 scope;拒绝后给出返回应用的出口。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { page } from '../../styles/product-surface.stylex'
import { Button, Notice, Spinner } from '../../components/ui'
import { AuthLayout, type AuthContextCopy } from '../../components/layout'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { AccountChip } from '../../components/hosted/IdentityChip'
import { hosted } from '../../components/hosted/hosted-styles'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useAuth } from '../../lib/auth-context'
import { queryErrorInput } from '../../lib/query-error'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { trackConsentDecision } from '../../lib/google-analytics-funnel'
import { ClientHeader } from './ClientHeader'
import { ConsentActions } from './ConsentActions'
import { splitConsentScopes, type ConsentParams } from './consent-model'
import { AlreadyAllowed, AuthorizationDetailsList, ScopeList } from './ScopeList'

export type { ConsentParams } from './consent-model'

function useConsentContext(
  params: ConsentParams | undefined,
  denied: boolean,
): AuthContextCopy | undefined {
  const { t } = useLingui()
  if (!params) return undefined
  const app = params.clientName
  if (denied) {
    return {
      lead: t`Nothing was shared with`,
      title: app,
      description: t`${app} will be told you said no. You can try again from ${app} whenever you're ready.`,
    }
  }
  return {
    lead: params.firstParty ? t`An app from your organization` : t`An app asking for access`,
    title: app,
    description: t`Only you decide what ${app} can see.`,
  }
}

function DestinationNote({ origin }: { origin: string | null }): ReactNode {
  if (!origin) return null
  return (
    <p {...stylex.props(hosted.note)}>
      <Trans>After you choose, you'll go to</Trans>{' '}
      <span {...stylex.props(hosted.mono)}>{origin}</span>
    </p>
  )
}

function ConsentForm(props: {
  params: ConsentParams
  above: ReactNode
  isSubmitting: boolean
  submitError: string | null
  onDecide: (approved: boolean) => void
}): ReactNode {
  const { user } = useAuth()
  const { params } = props
  const app = params.clientName
  const scopes = splitConsentScopes(params)
  const details: Record<string, ReactNode> = {
    ...(user?.name ? { profile: user.name } : {}),
    ...(user?.email ? { email: user.email } : {}),
  }
  const hasResources = params.authorizationDetails.length > 0
  return (
    <div {...stylex.props(hosted.screen)}>
      <ClientHeader
        client={{
          name: app,
          logoUrl: params.clientLogoUrl,
          ownerName: params.ownerOrganizationName,
          firstParty: params.firstParty,
        }}
      />
      <AuthHeading
        above={props.above}
        title={
          hasResources ? (
            <Trans>{app} wants to work with your data</Trans>
          ) : scopes.isReconsent ? (
            <Trans>{app} is asking for more access</Trans>
          ) : (
            <Trans>{app} wants access to your account</Trans>
          )
        }
      />
      <ScopeList
        heading={
          scopes.isReconsent ? (
            <Trans>New since you last allowed {app}</Trans>
          ) : (
            <Trans>{app} will be able to</Trans>
          )
        }
        scopes={scopes.added}
        details={details}
      />
      <AuthorizationDetailsList details={params.authorizationDetails} />
      <AlreadyAllowed scopes={scopes.alreadyAllowed} />
      {props.submitError ? <Notice tone="danger">{props.submitError}</Notice> : null}
      <ConsentActions
        isSubmitting={props.isSubmitting}
        onAllow={() => props.onDecide(true)}
        onDeny={() => props.onDecide(false)}
      />
      <DestinationNote origin={params.redirectOrigin} />
    </div>
  )
}

function Denied(props: {
  params: ConsentParams
  above: ReactNode
  redirectUrl: string
}): ReactNode {
  const app = props.params.clientName
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>You didn't allow {app}</Trans>}
        lead={
          <Trans>
            Nothing from your account was shared. {app} will show its own message about what to do
            next.
          </Trans>
        }
      />
      <div {...stylex.props(hosted.group)}>
        <Button
          variant="accent"
          size="lg"
          fullWidth
          onClick={() => globalThis.location.assign(props.redirectUrl)}
        >
          <Trans>Return to {app}</Trans>
        </Button>
        <DestinationNote origin={props.params.redirectOrigin} />
      </div>
    </div>
  )
}

function Unavailable({ message }: { message: string }): ReactNode {
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading title={<Trans>This request can't continue</Trans>} lead={message} />
      <Link to="/sign-in" {...stylex.props(hosted.textLink)}>
        <Trans>Back to sign in</Trans>
      </Link>
    </div>
  )
}

function ConsentPage(): ReactNode {
  const { t } = useLingui()
  const { api, user } = useAuth()
  const navigate = useNavigate()
  const apiErrorMessage = useApiErrorMessage()
  const search = useSearch({ strict: false }) as { prompt_id?: string; authz_request_id?: string }
  const promptId = search.prompt_id ?? search.authz_request_id ?? ''

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

  const decision = useMutation({
    mutationFn: (approved: boolean) =>
      api.post<{ redirectUrl: string }>('/auth/consent', { promptId, approved }),
    onSuccess: (result, approved) => {
      if (!result.ok) return
      trackConsentDecision(approved)
      if (approved) void navigate(result.value.redirectUrl)
    },
  })

  const deniedRedirect =
    decision.data?.ok === true && decision.variables === false
      ? decision.data.value.redirectUrl
      : null
  const context = useConsentContext(paramsQuery.data, deniedRedirect !== null)
  const above = user?.email ? <AccountChip label={user.email} /> : undefined
  const submitError =
    decision.data && !decision.data.ok
      ? apiErrorMessage(decision.data.error, { surface: 'general' })
      : null

  return (
    <AuthLayout context={context}>
      {!promptId ? (
        <Unavailable
          message={t`This authorization request is missing or has expired. Start again from the app.`}
        />
      ) : paramsQuery.isPending ? (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Loading the request`} />
        </div>
      ) : paramsQuery.isError ? (
        <Unavailable
          message={apiErrorMessage(queryErrorInput(paramsQuery.error), { surface: 'general' })}
        />
      ) : deniedRedirect ? (
        <Denied params={paramsQuery.data} above={above} redirectUrl={deniedRedirect} />
      ) : decision.data?.ok === true ? (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Returning to the app`} />
        </div>
      ) : (
        <ConsentForm
          params={paramsQuery.data}
          above={above}
          isSubmitting={decision.isPending}
          submitError={submitError}
          onDecide={(approved) => decision.mutate(approved)}
        />
      )}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/consent')({
  component: ConsentPage,
})

export default ConsentPage
