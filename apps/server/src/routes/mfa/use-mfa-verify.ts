// 四种 MFA 方法共用的提交、错误映射与续跑:验证码错误用各方法自己的文案,其余错误走统一映射。

import { useLingui } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { apiErrorDescriptor } from '@xid-kit/web-ui/api-error-message'
import { classifyApiError } from '@xid-kit/web-ui/api-errors'
import { useState } from 'react'
import { useAuth } from '../../lib/auth-context'
import { trackMfaComplete } from '../../lib/google-analytics-funnel'
import { browserStorage } from '../sign-in/method-order'
import { writeLastMfaMethod, type MfaMethod } from './mfa-search'
import { useMfaResume } from './use-mfa-resume'

const ANALYTICS_METHOD = {
  totp: 'totp',
  backup: 'backup_code',
  sms: 'sms',
  passkey: 'passkey',
} as const

export type MfaVerifyRequest = {
  path: '/auth/mfa/verify' | '/auth/mfa/passkey/verify'
  body: Record<string, unknown>
}

export type MfaVerify = {
  submit: (request: MfaVerifyRequest) => Promise<void>
  isPending: boolean
  error: string | null
  setError: (message: string | null) => void
}

export function useMfaVerify(options: { method: MfaMethod; invalidMessage: string }): MfaVerify {
  const { i18n } = useLingui()
  const { api, refresh } = useAuth()
  const resume = useMfaResume()
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (request: MfaVerifyRequest) => api.post<unknown>(request.path, request.body),
    onSuccess: async (result) => {
      if (!result.ok) {
        // MFA 验证属于凭证面:错码、未知方法、凭证不存在统一归为验证码错误。
        const classification = classifyApiError(result.error, { surface: 'credential' })
        setError(
          classification.code === 'invalid_credentials'
            ? options.invalidMessage
            : i18n._(apiErrorDescriptor(classification)),
        )
        return
      }
      trackMfaComplete(ANALYTICS_METHOD[options.method])
      writeLastMfaMethod(browserStorage(), options.method)
      await refresh()
      resume()
    },
  })

  return {
    submit: async (request) => {
      setError(null)
      await mutation.mutateAsync(request)
    },
    isPending: mutation.isPending,
    error,
    setError,
  }
}
