// SignInButton:无样式登录触发按钮(对标 Clerk <SignInButton>)。
// mode=redirect -> 跳转 Hosted UI;mode=modal -> 触发父层弹窗(需配合 <SignIn modal />)。

import type { ReactNode } from 'react'

import { useLingui } from '@lingui/react'

import { useXidContext } from '../../context/xid-context'
import { rt, sdkMessages } from '../../i18n-runtime'
import { runAuthorizationRedirect } from './authorization-redirect'

export type SignInButtonProps = {
  children?: ReactNode
  // 登录页路径(Hosted UI)
  signInUrl?: string
  // 登录成功后跳转
  redirectUrl?: string
  mode?: 'redirect'
  onError?: (error: unknown) => void
  // a11y
  'aria-label'?: string
}

export function SignInButton({
  children,
  signInUrl = '/sign-in',
  redirectUrl,
  onError,
  'aria-label': ariaLabel,
}: SignInButtonProps): ReactNode {
  const { client, mode } = useXidContext()
  const { _ } = useLingui()

  function handleClick(): void {
    runAuthorizationRedirect(
      {
        client,
        mode,
        intent: 'sign-in',
        ...(redirectUrl ? { returnUrl: redirectUrl } : {}),
        sameOriginPath: signInUrl,
      },
      onError,
    )
  }

  return (
    <button type="button" onClick={handleClick} aria-label={ariaLabel}>
      {children ?? rt(_, sdkMessages.signIn)}
    </button>
  )
}
