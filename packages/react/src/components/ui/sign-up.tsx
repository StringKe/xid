// SignUp:Hosted Auth 注册重定向卡片(对标 Clerk <SignUp>)。

import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'
import { runAuthorizationRedirect } from '../control/authorization-redirect'

export type SignUpProps = {
  signUpUrl?: string
  signInUrl?: string
  redirectUrl?: string
  appearance?: Appearance
  className?: string
  onError?: (error: unknown) => void
}

export function SignUp({
  signUpUrl = '/sign-up',
  signInUrl = '/sign-in',
  redirectUrl,
  appearance,
  className,
  onError,
}: SignUpProps): ReactNode {
  const { client, mode } = useXidContext()
  const { _ } = useLingui()

  const cssVars = buildCssVariables(appearance?.variables)
  const cardClass = cx('xid-sign-up', appearance?.elements?.card, className)

  function start(intent: 'sign-in' | 'sign-up', path: string): void {
    runAuthorizationRedirect(
      {
        client,
        mode,
        intent,
        ...(redirectUrl ? { returnUrl: redirectUrl } : {}),
        sameOriginPath: path,
      },
      onError,
    )
  }

  return (
    <div
      className={cardClass}
      style={cssVars as CSSProperties}
      role="region"
      aria-label={rt(_, sdkMessages.signUp)}
    >
      <div className={cx('xid-sign-up__header', appearance?.elements?.cardHeader)}>
        <h2>
          <Rt {...sdkMessages.createYourAccount} />
        </h2>
      </div>
      <div className={cx('xid-sign-up__body', appearance?.elements?.formButton)}>
        <button
          type="button"
          className={cx('xid-button xid-button--primary', appearance?.elements?.buttonPrimary)}
          onClick={() => start('sign-up', signUpUrl)}
        >
          <Rt {...sdkMessages.continueToSignUp} />
        </button>
      </div>
      {signInUrl ? (
        <div className={cx('xid-sign-up__footer', appearance?.elements?.cardFooter)}>
          <Rt
            {...sdkMessages.alreadyHaveAccountSignIn}
            components={{
              0: <button type="button" onClick={() => start('sign-in', signInUrl)} />,
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
