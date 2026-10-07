// OAuth Device Flow 用户端:带码链接先核对屏幕上的码,手动输入则按 RFC 8628 字符集校验,
// 详情页说明设备会拿到什么,再允许或拒绝。
// client_id 来自 verification_uri,随每个 API 请求带上,让 Worker 解析到 client 所属租户。
// 激活 API 用不带 401 回调的 client:当前会话属于其他租户时 401 只表示「换账号」,
// 不能清掉本页会话状态,否则 RequireAuth 会在登录页与本页之间来回跳转。

import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { signInRedirectTarget } from '@xid-kit/web-ui/session'
import { AuthLayout, type AuthContextCopy } from '../../components/layout'
import { Spinner } from '../../components/ui'
import { AccountChip } from '../../components/hosted/IdentityChip'
import { normalizeCode } from '../../components/hosted/code-input'
import { hosted } from '../../components/hosted/hosted-styles'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth-context'
import { trackDeviceActivationDecision } from '../../lib/google-analytics-funnel'
import { queryErrorInput } from '../../lib/query-error'
import { Link, useLocation } from '@xid-kit/web-ui/tanstack-router'
import { page } from '../../styles/product-surface.stylex'
import {
  ApproveDeviceStep,
  CheckCodeStep,
  CodeEntryStep,
  DeviceFailedStep,
  DeviceResultStep,
  type DeviceActivationParams,
} from './DeviceSteps'

type Stage = 'enter' | 'check' | 'approve'

function useDeviceErrorMessage(): (error: Pick<XidError, 'code' | 'meta'>) => string {
  const { t } = useLingui()
  const apiErrorMessage = useApiErrorMessage()
  return (error) => {
    if (error.code === 'invalid_request' || error.code === 'expired_token') {
      return t`Codes expire after 10 minutes and work only once. Get a new code on your device, then enter it here.`
    }
    if (error.code === 'conflict') return t`This device request was already answered.`
    if (error.code === 'unauthorized') return t`Sign in with the account this device belongs to.`
    return apiErrorMessage(error, { surface: 'general' })
  }
}

function useDeviceContext(
  app: string | null,
  outcome: 'allowed' | 'denied' | null,
): AuthContextCopy {
  const { t } = useLingui()
  const title = app ?? t`A device`
  if (outcome === 'allowed')
    return {
      lead: t`Device connected`,
      title,
      description: t`The device is now signed in to your account.`,
    }
  if (outcome === 'denied')
    return {
      lead: t`Request denied`,
      title,
      description: t`No device was signed in. You can start again from the device at any time.`,
    }
  return {
    lead: t`Connecting a device`,
    title,
    description: t`A device is asking to sign in as you. Only continue if you started this on a device you can see right now.`,
  }
}

function ActivatePage(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const location = useLocation()
  const { config } = useHostedAuthConfig()
  const deviceErrorMessage = useDeviceErrorMessage()
  const search = useSearch({ strict: false }) as { user_code?: string; client_id?: string }
  const clientId = search.client_id
  const linkedCode = useMemo(
    () => normalizeCode(search.user_code ?? '', 'device'),
    [search.user_code],
  )
  const [activeCode, setActiveCode] = useState(linkedCode)
  const [stage, setStage] = useState<Stage>(linkedCode ? 'check' : 'enter')
  const [now] = useState(() => Date.now())

  const paramsQuery = useQuery({
    queryKey: ['device-activation', clientId, activeCode],
    enabled: Boolean(activeCode),
    retry: false,
    staleTime: 0,
    queryFn: async (): Promise<DeviceActivationParams> => {
      const result = await api.get<DeviceActivationParams>('/auth/device-activation', {
        query: { user_code: activeCode, client_id: clientId },
      })
      if (!result.ok) throw result.error
      return result.value
    },
  })

  const decision = useMutation({
    mutationFn: (approved: boolean) =>
      api.post<{ approved: boolean }>(
        '/auth/device-activation',
        { userCode: activeCode, approved },
        { query: { client_id: clientId } },
      ),
    onSuccess: (result, approved) => {
      if (result.ok) trackDeviceActivationDecision(approved)
    },
  })

  const outcome =
    decision.data?.ok === true ? (decision.data.value.approved ? 'allowed' : 'denied') : null
  const app = paramsQuery.data?.clientName ?? null
  const context = useDeviceContext(app, outcome)
  const above = user?.email ? <AccountChip label={user.email} /> : undefined
  const queryError = paramsQuery.isError ? queryErrorInput(paramsQuery.error) : null
  const submitError =
    decision.data && !decision.data.ok ? deviceErrorMessage(decision.data.error) : null

  function restart(): void {
    decision.reset()
    setActiveCode('')
    setStage('enter')
  }

  function content(): ReactNode {
    if (outcome && app) {
      return (
        <DeviceResultStep
          above={above}
          app={app}
          outcome={outcome}
          organizationName={config.context.organizationName}
        />
      )
    }
    if (queryError?.code === 'unauthorized') {
      return (
        <div {...stylex.props(hosted.screen)}>
          <DeviceFailedStep
            above={above}
            message={deviceErrorMessage(queryError)}
            onRetry={restart}
          />
          <Link
            to={`${signInRedirectTarget(location.pathname, location.search, location.hash)}&select_account=1`}
            {...stylex.props(hosted.textLink)}
          >
            <Trans>Sign in with another account</Trans>
          </Link>
        </div>
      )
    }
    if (queryError && stage !== 'enter') {
      return (
        <DeviceFailedStep
          above={above}
          message={deviceErrorMessage(queryError)}
          onRetry={restart}
        />
      )
    }
    // 手动输入的码在确认存在前留在输入屏,错误就地显示。
    if ((stage === 'enter' && !paramsQuery.data) || !activeCode) {
      return (
        <CodeEntryStep
          above={above}
          initialCode={activeCode}
          error={queryError ? deviceErrorMessage(queryError) : null}
          isLoading={paramsQuery.isFetching}
          onSubmit={setActiveCode}
        />
      )
    }
    if (!paramsQuery.data) {
      return (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Loading the device request`} />
        </div>
      )
    }
    if (stage === 'check') {
      return (
        <CheckCodeStep
          above={above}
          params={paramsQuery.data}
          now={now}
          isSubmitting={decision.isPending}
          onMatch={() => setStage('approve')}
          onMismatch={() => decision.mutate(false)}
        />
      )
    }
    return (
      <ApproveDeviceStep
        above={above}
        params={paramsQuery.data}
        isSubmitting={decision.isPending}
        submitError={submitError}
        onDecide={(approved) => decision.mutate(approved)}
      />
    )
  }

  return <AuthLayout context={context}>{content()}</AuthLayout>
}

export const Route = createLazyRoute('/activate')({
  component: ActivatePage,
})

export default ActivatePage
