// SignUp:嵌入式注册组件(对标 Clerk <SignUp>)。
// 与 SignIn 对称:redirect 模式跳转 Hosted UI 注册页,hash/path 模式内嵌 iframe。

import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'

export type SignUpProps = {
  signUpUrl?: string
  signInUrl?: string
  redirectUrl?: string
  routing?: 'redirect' | 'hash' | 'path'
  appearance?: Appearance
  className?: string
}

export function SignUp({
  signUpUrl = '/sign-up',
  signInUrl = '/sign-in',
  redirectUrl,
  routing = 'redirect',
  appearance,
  className,
}: SignUpProps): ReactNode {
  const { publishableKey } = useXidContext()
  const { _ } = useLingui()

  const cssVars = buildCssVariables(appearance?.variables)
  const cardClass = cx('xid-sign-up', appearance?.elements?.card, className)

  if (routing === 'redirect') {
    const target = redirectUrl
      ? `${signUpUrl}?redirect_url=${encodeURIComponent(redirectUrl)}&pk=${encodeURIComponent(publishableKey)}`
      : `${signUpUrl}?pk=${encodeURIComponent(publishableKey)}`

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
          <a
            href={target}
            className={cx('xid-button xid-button--primary', appearance?.elements?.buttonPrimary)}
            role="button"
          >
            <Rt {...sdkMessages.continueToSignUp} />
          </a>
        </div>
        {signInUrl && (
          <div className={cx('xid-sign-up__footer', appearance?.elements?.cardFooter)}>
            <Rt
              {...sdkMessages.alreadyHaveAccountSignIn}
              components={{ 0: <a href={signInUrl} /> }}
            />
          </div>
        )}
      </div>
    )
  }

  const iframeSrc = redirectUrl
    ? `${signUpUrl}?redirect_url=${encodeURIComponent(redirectUrl)}&pk=${encodeURIComponent(publishableKey)}&embedded=1`
    : `${signUpUrl}?pk=${encodeURIComponent(publishableKey)}&embedded=1`

  return (
    <div
      className={cardClass}
      style={cssVars as CSSProperties}
      role="region"
      aria-label={rt(_, sdkMessages.signUp)}
    >
      <iframe
        src={iframeSrc}
        title={rt(_, sdkMessages.signUp)}
        style={{ border: 'none', width: '100%', minHeight: 520 }}
        aria-label={rt(_, sdkMessages.signUpForm)}
      />
    </div>
  )
}
