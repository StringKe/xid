// /activate:OAuth Device Authorization Grant 用户端 activation 页面。
// 支持 verification_uri_complete?user_code=... 和手动输入 user_code。
// 已登录后调用 /auth/device-activation 查询并 approve/deny。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Alert, Button, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackDeviceActivationDecision } from '../../lib/google-analytics-funnel'
import { page } from '../../styles/product-surface.stylex'
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

function ActivatePage(): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const search = useSearch({ strict: false }) as { user_code?: string }
  const initialCode = useMemo(() => normalizeUserCode(search.user_code ?? ''), [search.user_code])
  const [enteredCode, setEnteredCode] = useState(initialCode)
  const [activeCode, setActiveCode] = useState(initialCode)

  useEffect(() => {
    setEnteredCode(initialCode)
    setActiveCode(initialCode)
  }, [initialCode])

  const paramsQuery = useQuery({
    queryKey: ['device-activation', activeCode],
    enabled: Boolean(activeCode),
    retry: false,
    staleTime: 0,
    queryFn: async (): Promise<DeviceActivationParams> => {
      const result = await api.get<DeviceActivationParams>('/auth/device-activation', {
        query: { user_code: activeCode },
      })
      if (!result.ok) throw result.error
      return result.value
    },
  })

  const activationMutation = useMutation({
    mutationFn: (approved: boolean) =>
      api.post<{ approved: boolean }>('/auth/device-activation', {
        userCode: activeCode,
        approved,
      }),
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
              ? t`The device can continue sign-in.`
              : t`The device request was denied.`}
          </Alert>
          <Button variant="secondary" fullWidth onClick={() => globalThis.close()}>
            <Trans>Close this page</Trans>
          </Button>
        </div>
      </AuthLayout>
    )
  }

  const queryError =
    paramsQuery.error && typeof paramsQuery.error === 'object' && 'longMessage' in paramsQuery.error
      ? ((paramsQuery.error as { longMessage?: string; message?: string }).longMessage ??
        (paramsQuery.error as { message?: string }).message ??
        t`Device request not found or expired.`)
      : t`Device request not found or expired.`
  const submitError =
    activationMutation.isSuccess && !activationMutation.data?.ok
      ? (activationMutation.data.error.longMessage ??
        activationMutation.data.error.message ??
        t`Device request failed.`)
      : null

  return (
    <AuthLayout>
      <div {...stylex.props(styles.stack)}>
        <CodeEntryForm
          value={enteredCode}
          onChange={setEnteredCode}
          onSubmit={handleSubmit}
          error={paramsQuery.isError ? queryError : null}
        />

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
