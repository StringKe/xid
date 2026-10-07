// 验证码发送:记录发送时间与是否重发,成功后清空已填验证码;失败交给统一错误映射。

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { XidError } from '@xid-kit/types'
import { trackOtpSent, type AuthFlowIntent } from '../../lib/google-analytics-funnel'
import { isOtpMethod, type ProfileValues, type SignInErrorKey, type SignInMethod } from './shared'
import { otpTarget } from './sign-in-requests'
import type { useCredentialMutations } from './useCredentialMutations'

export type OtpSendOptions = {
  otpSend: ReturnType<typeof useCredentialMutations>['otpSend']
  identifier: string
  isSignUpFlow: boolean
  profileValues: ProfileValues
  analyticsIntent: AuthFlowIntent
  showApiError: (apiError: Pick<XidError, 'code' | 'meta'>) => void
  setError: Dispatch<SetStateAction<SignInErrorKey | null>>
}

export type OtpSend = {
  otpCode: string
  setOtpCode: Dispatch<SetStateAction<string>>
  otpSentAt: number | null
  setOtpSentAt: Dispatch<SetStateAction<number | null>>
  otpResent: boolean
  setOtpResent: Dispatch<SetStateAction<boolean>>
  sendOtp: (otpMethod: SignInMethod) => void
}

export function useOtpSend(options: OtpSendOptions): OtpSend {
  const { otpSend, identifier, isSignUpFlow, profileValues, analyticsIntent, showApiError } =
    options
  const { setError } = options
  const [otpCode, setOtpCode] = useState('')
  const [otpSentAt, setOtpSentAt] = useState<number | null>(null)
  const [otpResent, setOtpResent] = useState(false)

  const sendOtp = useCallback(
    (otpMethod: SignInMethod): void => {
      if (!isOtpMethod(otpMethod)) return
      const resend = otpSentAt !== null
      otpSend.mutate(
        {
          method: otpMethod,
          target: identifier.trim(),
          profile: isSignUpFlow ? profileValues : null,
        },
        {
          onSuccess: (result) => {
            if (!result.ok) return showApiError(result.error)
            trackOtpSent(otpTarget(otpMethod).channel, analyticsIntent)
            setError(null)
            setOtpCode('')
            setOtpSentAt(Date.now())
            setOtpResent(resend)
          },
        },
      )
    },
    [
      analyticsIntent,
      otpSend,
      identifier,
      isSignUpFlow,
      otpSentAt,
      profileValues,
      setError,
      showApiError,
    ],
  )

  return { otpCode, setOtpCode, otpSentAt, setOtpSentAt, otpResent, setOtpResent, sendOtp }
}
