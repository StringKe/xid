// 登录错误文案:写「发生了什么 + 下一步」;凭证错误不区分账号不存在与凭证错误,限流不点名维度。

import { useLingui } from '@lingui/react/macro'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import type { ApiErrorInput } from '@xid-kit/web-ui/api-errors'
import {
  isSignInCorrectableErrorKey,
  type SignInCorrectableErrorKey,
  type SignInErrorKey,
} from './shared'

function correctableError(key: SignInCorrectableErrorKey): ApiErrorInput {
  return key === 'password_too_short'
    ? { code: 'validation_failed', meta: { paramName: 'password' } }
    : { code: key }
}

export function useSignInErrorMessage(): (key: SignInErrorKey | null) => string | null {
  const { t } = useLingui()
  const apiErrorMessage = useApiErrorMessage()
  return (key) => {
    if (key !== null && isSignInCorrectableErrorKey(key)) {
      return apiErrorMessage(correctableError(key), { surface: 'general' })
    }
    switch (key) {
      case 'auth_failed':
        return t`That didn't work. Check what you entered and try again, or try another way.`
      case 'rate_limited':
        return t`Too many attempts. Wait a few minutes, then try again. You can also sign in another way.`
      case 'account_locked':
        return t`This account can't sign in right now. Try again later, or ask your administrator to unlock it.`
      case 'captcha_required':
        return t`The security check didn't finish. Reload the page and try again.`
      case 'network_error':
        return t`We couldn't reach the server. Check your connection and try again.`
      case 'passkey_unavailable':
        return t`This browser can't use passkeys. Try another way to sign in.`
      case 'identifier_required':
        return t`Enter your email, username or phone number to continue.`
      case 'sso_not_available':
        return t`This email address doesn't use single sign-on here. Sign in another way.`
      case 'cancelled':
        return t`Sign-in was cancelled. Choose a way to sign in to try again.`
      case 'session_expired':
        return t`Your sign-in took too long and expired. Start again.`
      case 'sign_in_failed':
        return t`We couldn't sign you in with that account. Try again or sign in another way.`
      case 'handoff_failed':
        return t`We couldn't carry your sign-in over to this address. Sign in again to continue.`
      case 'verify_email_sent':
        return t`Check your email to confirm your address, then sign in.`
      default:
        return null
    }
  }
}
