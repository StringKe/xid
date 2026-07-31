// SignIn:Hosted Auth 重定向卡片(对标 Clerk <SignIn>)。
// 文案走 lingui runtime descriptor;appearance prop 支持主题变量覆盖。

import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'
import { runAuthorizationRedirect } from '../control/authorization-redirect'

export type SignInProps = {
  // 跳转式:指定 Hosted UI 的登录 URL
  signInUrl?: string
  // 注册页链接(卡片底部)
  signUpUrl?: string
  // 登录后重定向
  redirectUrl?: string
  appearance?: Appearance
  className?: string
  onError?: (error: unknown) => void
}

export function SignIn({
  signInUrl = '/sign-in',
  signUpUrl = '/sign-up',
  redirectUrl,
  appearance,
  className,
  onError,
}: SignInProps): ReactNode {
  const { client, mode } = useXidContext()
  const { _ } = useLingui()

  const cssVars = buildCssVariables(appearance?.variables)
  const cardClass = cx('xid-sign-in', appearance?.elements?.card, className)

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
      aria-label={rt(_, sdkMessages.signIn)}
    >
      <div className={cx('xid-sign-in__header', appearance?.elements?.cardHeader)}>
        <h2>
          <Rt {...sdkMessages.signIn} />
        </h2>
      </div>
      <div className={cx('xid-sign-in__body', appearance?.elements?.formButton)}>
        <button
          type="button"
          className={cx('xid-button xid-button--primary', appearance?.elements?.buttonPrimary)}
          onClick={() => start('sign-in', signInUrl)}
        >
          <Rt {...sdkMessages.continueToSignIn} />
        </button>
      </div>
      {signUpUrl ? (
        <div className={cx('xid-sign-in__footer', appearance?.elements?.cardFooter)}>
          <Rt
            {...sdkMessages.dontHaveAccountSignUp}
            components={{
              0: <button type="button" onClick={() => start('sign-up', signUpUrl)} />,
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
