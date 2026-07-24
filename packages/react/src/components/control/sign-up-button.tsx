// SignUpButton:无样式注册触发按钮(对标 Clerk <SignUpButton>)。

import type { ReactNode } from 'react'

import { useLingui } from '@lingui/react'

import { rt, sdkMessages } from '../../i18n-runtime'

export type SignUpButtonProps = {
  children?: ReactNode
  signUpUrl?: string
  redirectUrl?: string
  'aria-label'?: string
}

export function SignUpButton({
  children,
  signUpUrl = '/sign-up',
  redirectUrl,
  'aria-label': ariaLabel,
}: SignUpButtonProps): ReactNode {
  const { _ } = useLingui()

  function handleClick(): void {
    const target = redirectUrl
      ? `${signUpUrl}?redirect_url=${encodeURIComponent(redirectUrl)}`
      : signUpUrl
    window.location.assign(target)
  }

  return (
    <button type="button" onClick={handleClick} aria-label={ariaLabel}>
      {children ?? rt(_, sdkMessages.signUp)}
    </button>
  )
}
