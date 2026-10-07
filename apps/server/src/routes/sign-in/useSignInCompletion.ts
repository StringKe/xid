// 登录结果的去向:错误映射为模糊 key 或转组织选择,成功后刷新会话并按需插入 passkey 引导页。

import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { Result, XidError } from '@xid-kit/types'
import type { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import type { AuthContextValue } from '../../lib/auth-context'
import { trackAuthSuccess, type AuthFlowIntent } from '../../lib/google-analytics-funnel'
import { clearPendingAuthCompletion } from '../../lib/google-analytics-pending-auth'
import { browserStorage, writeLastAuthMethod } from './method-order'
import { apiErrorToKey, type SignInErrorKey, type SignInMethod } from './shared'
import { passkeyPromptPath } from './sign-in-entry'
import { organizationSelectionPath } from './sign-in-requests'
import { AUTH_METHOD_BY_SIGN_IN_METHOD, type SignInSearch } from './sign-in-types'
import type { AuthResponse } from './useCredentialMutations'

export type SignInCompletionOptions = {
  navigate: ReturnType<typeof useNavigate>
  refresh: AuthContextValue['refresh']
  search: SignInSearch
  identifier: string
  analyticsIntent: AuthFlowIntent
  enabledMethods: readonly SignInMethod[]
  hostedReturn: string
  isSignUpFlow: boolean
  setError: Dispatch<SetStateAction<SignInErrorKey | null>>
}

export type SignInCompletion = {
  showApiError: (apiError: Pick<XidError, 'code' | 'meta'>) => void
  finishSignIn: (
    redirectUrl: string | undefined,
    signedInWith: SignInMethod | 'guest',
  ) => Promise<void>
  handleAuthResult: (result: Result<AuthResponse>, signedInWith: SignInMethod) => Promise<void>
}

export function useSignInCompletion(options: SignInCompletionOptions): SignInCompletion {
  const { navigate, refresh, search, identifier, analyticsIntent, enabledMethods } = options
  const { hostedReturn, isSignUpFlow, setError } = options

  const showApiError = useCallback(
    (apiError: Pick<XidError, 'code' | 'meta'>): void => {
      if (apiError.code === 'organization_selection_required' && identifier.trim()) {
        setError(null)
        navigate(organizationSelectionPath(search, identifier), { replace: true })
        return
      }
      setError(apiErrorToKey(apiError))
    },
    [identifier, navigate, search, setError],
  )

  const finishSignIn = useCallback(
    async (
      redirectUrl: string | undefined,
      signedInWith: SignInMethod | 'guest',
    ): Promise<void> => {
      clearPendingAuthCompletion()
      trackAuthSuccess({
        method: signedInWith === 'guest' ? 'guest' : AUTH_METHOD_BY_SIGN_IN_METHOD[signedInWith],
        intent: analyticsIntent,
      })
      if (signedInWith !== 'guest') writeLastAuthMethod(browserStorage(), signedInWith)
      await refresh()
      const target = redirectUrl ?? hostedReturn
      const prompt =
        signedInWith !== 'guest' &&
        signedInWith !== 'passkey' &&
        enabledMethods.includes('passkey') &&
        !target.startsWith('/mfa') &&
        !isSignUpFlow
          ? passkeyPromptPath(target)
          : null
      navigate(prompt ?? target, { replace: true })
    },
    [analyticsIntent, enabledMethods, hostedReturn, isSignUpFlow, navigate, refresh],
  )

  const handleAuthResult = useCallback(
    async (result: Result<AuthResponse>, signedInWith: SignInMethod): Promise<void> => {
      if (!result.ok) return showApiError(result.error)
      if (result.value.nextStep === 'verify_email') return setError('verify_email_sent')
      await finishSignIn(result.value.redirectUrl, signedInWith)
    },
    [finishSignIn, setError, showApiError],
  )

  return { showApiError, finishSignIn, handleAuthResult }
}
