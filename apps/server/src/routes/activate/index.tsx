// OAuth Device Flow 用户端 activation;登录后走 /auth/device-activation approve/deny。
// client_id 来自 verification_uri,随每个 API 请求带上,让 Worker 解析到 client 所属租户。
// 激活 API 用不带 401 回调的 client:当前会话属于其他租户时 401 只表示「换账号」,
// 不能清掉本页会话状态,否则 RequireAuth 会在登录页与本页之间来回跳转。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { AuthLayout } from '../../components/layout'
import { Alert, Spinner } from '../../components/ui'
import { signInRedirectTarget } from '@xid-kit/web-ui/session'
import { api } from '../../lib/api'
import { trackDeviceActivationDecision } from '../../lib/google-analytics-funnel'
import { queryErrorInput } from '../../lib/query-error'
import { Link, useLocation } from '@xid-kit/web-ui/tanstack-router'
import { page } from '../../styles/product-surface.stylex'
import { styles as signInStyles } from '../sign-in/styles'
import { ActivationDetails } from './ActivationDetails'
import type { DeviceActivationParams } from './ActivationDetails'
import { CodeEntryForm } from './CodeEntryForm'

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
})

function normalizeUserCode(value: string): string {
  return value.trim().replaceAll(' ', '').replaceAll('-', '').toUpperCase()
}

function useDeviceErrorMessage(): (error: Pick<XidError, 'code' | 'meta'>) => string {
  const { t } = useLingui()
  const apiErrorMessage = useApiErrorMessage()
  return (error) => {
    if (error.code === 'invalid_request' || error.code === 'expired_token') {
      return t`This code is invalid or has expired. Check the code on your device and try again.`
    }
    if (error.code === 'conflict') return t`This device request has already been handled.`
    if (error.code === 'unauthorized') {
      return t`Sign in with the account that this application belongs to.`
    }
    return apiErrorMessage(error, { surface: 'general' })
  }
}

function ActivatePage(): ReactNode {
  const { t } = useLingui()
  const location = useLocation()
  const deviceErrorMessage = useDeviceErrorMessage()
  const search = useSearch({ strict: false }) as { user_code?: string; client_id?: string }
  const clientId = search.client_id
  const initialCode = useMemo(() => normalizeUserCode(search.user_code ?? ''), [search.user_code])
  const [enteredCode, setEnteredCode] = useState(initialCode)
  const [activeCode, setActiveCode] = useState(initialCode)

  useEffect(() => {
    setEnteredCode(initialCode)
    setActiveCode(initialCode)
  }, [initialCode])

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

  const activationMutation = useMutation({
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

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const nextCode = normalizeUserCode(enteredCode)
    setEnteredCode(nextCode)
    setActiveCode(nextCode)
  }

  if (!activeCode) {
    return (
      <AuthLayout>
        <CodeEntryForm
          value={enteredCode}
          onChange={setEnteredCode}
          onSubmit={handleSubmit}
          error={null}
        />
      </AuthLayout>
    )
  }

  if (activationMutation.isSuccess && activationMutation.data?.ok === true) {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)} aria-live="polite">
          <Alert tone="success" title={<Trans>Device request handled</Trans>}>
            {activationMutation.data.value.approved
              ? t`The device can continue sign-in. You can close this page and return to your device.`
              : t`The device request was denied. You can close this page.`}
          </Alert>
          <Link to="/account" {...stylex.props(signInStyles.textLink)}>
            <Trans>Go to your account</Trans>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const queryError = paramsQuery.isError ? queryErrorInput(paramsQuery.error) : null
  const submitError =
    activationMutation.isSuccess && activationMutation.data?.ok === false
      ? deviceErrorMessage(activationMutation.data.error)
      : null

  return (
    <AuthLayout>
      <div {...stylex.props(styles.stack)}>
        <CodeEntryForm
          value={enteredCode}
          onChange={setEnteredCode}
          onSubmit={handleSubmit}
          error={queryError ? deviceErrorMessage(queryError) : null}
        />

        {queryError?.code === 'unauthorized' ? (
          <Link
            to={`${signInRedirectTarget(location.pathname, location.search, location.hash)}&select_account=1`}
            {...stylex.props(signInStyles.textLink)}
          >
            <Trans>Sign in</Trans>
          </Link>
        ) : null}

        {paramsQuery.isPending ? (
          <div {...stylex.props(page.loadingCenter)} aria-live="polite">
            <Spinner label={t`Loading device request`} />
          </div>
        ) : null}

        {paramsQuery.data ? (
          <ActivationDetails
            params={paramsQuery.data}
            isSubmitting={activationMutation.isPending}
            submitError={submitError}
            onApprove={() => void activationMutation.mutate(true)}
            onDeny={() => void activationMutation.mutate(false)}
          />
        ) : null}
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/activate')({
  component: ActivatePage,
})

export default ActivatePage
