// SignUpButton:无样式注册触发按钮(对标 Clerk <SignUpButton>)。

import type { ReactNode } from 'react'

import { useLingui } from '@lingui/react'

import { useXidContext } from '../../context/xid-context'
import { rt, sdkMessages } from '../../i18n-runtime'
import { runAuthorizationRedirect } from './authorization-redirect'

export type SignUpButtonProps = {
  children?: ReactNode
  signUpUrl?: string
  redirectUrl?: string
  onError?: (error: unknown) => void
  'aria-label'?: string
}

export function SignUpButton({
  children,
  signUpUrl = '/sign-up',
  redirectUrl,
  onError,
  'aria-label': ariaLabel,
}: SignUpButtonProps): ReactNode {
  const { client, mode } = useXidContext()
  const { _ } = useLingui()

  function handleClick(): void {
    runAuthorizationRedirect(
      {
        client,
        mode,
        intent: 'sign-up',
        ...(redirectUrl ? { returnUrl: redirectUrl } : {}),
        sameOriginPath: signUpUrl,
      },
      onError,
    )
  }

  return (
    <button type="button" onClick={handleClick} aria-label={ariaLabel}>
      {children ?? rt(_, sdkMessages.signUp)}
    </button>
  )
}
