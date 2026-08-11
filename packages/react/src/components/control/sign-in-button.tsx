import type { ReactNode } from 'react'

import { useLingui } from '@lingui/react'

import { useXidContext } from '../../context/xid-context'
import { rt, sdkMessages } from '../../i18n-runtime'
import { runAuthorizationRedirect } from './authorization-redirect'

export type SignInButtonProps = {
  children?: ReactNode
  signInUrl?: string
  redirectUrl?: string
  mode?: 'redirect'
  onError?: (error: unknown) => void
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
