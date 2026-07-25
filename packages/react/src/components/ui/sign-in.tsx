// SignIn:嵌入式登录组件(对标 Clerk <SignIn>)。
// 默认跳转 Hosted UI;传 embedded 则渲染内嵌 iframe 指向 Hosted UI 登录页。
// 文案走 lingui runtime descriptor;appearance prop 支持主题变量覆盖。

import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'

export type SignInProps = {
  // 跳转式:指定 Hosted UI 的登录 URL
  signInUrl?: string
  // 注册页链接(卡片底部)
  signUpUrl?: string
  // 登录后重定向
  redirectUrl?: string
  // 嵌入式渲染(iframe)还是跳转式(默认 redirect)
  routing?: 'redirect' | 'hash' | 'path'
  appearance?: Appearance
  className?: string
}

export function SignIn({
  signInUrl = '/sign-in',
  signUpUrl = '/sign-up',
  redirectUrl,
  routing = 'redirect',
  appearance,
  className,
}: SignInProps): ReactNode {
  const { publishableKey } = useXidContext()
  const { _ } = useLingui()

  const cssVars = buildCssVariables(appearance?.variables)
  const cardClass = cx('xid-sign-in', appearance?.elements?.card, className)

  if (routing === 'redirect') {
    // 重定向模式:渲染一个简单的跳转卡片,实际登录在 Hosted UI 完成。
    const target = redirectUrl
      ? `${signInUrl}?redirect_url=${encodeURIComponent(redirectUrl)}&pk=${encodeURIComponent(publishableKey)}`
      : `${signInUrl}?pk=${encodeURIComponent(publishableKey)}`

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
          <a
            href={target}
            className={cx('xid-button xid-button--primary', appearance?.elements?.buttonPrimary)}
            role="button"
          >
            <Rt {...sdkMessages.continueToSignIn} />
          </a>
        </div>
        {signUpUrl && (
          <div className={cx('xid-sign-in__footer', appearance?.elements?.cardFooter)}>
            <Rt {...sdkMessages.dontHaveAccountSignUp} components={{ 0: <a href={signUpUrl} /> }} />
          </div>
        )}
      </div>
    )
  }

  // hash/path 模式:iframe 嵌入 Hosted UI
  const iframeSrc = redirectUrl
    ? `${signInUrl}?redirect_url=${encodeURIComponent(redirectUrl)}&pk=${encodeURIComponent(publishableKey)}&embedded=1`
    : `${signInUrl}?pk=${encodeURIComponent(publishableKey)}&embedded=1`

  return (
    <div
      className={cardClass}
      style={cssVars as CSSProperties}
      role="region"
      aria-label={rt(_, sdkMessages.signIn)}
    >
      <iframe
        src={iframeSrc}
        title={rt(_, sdkMessages.signIn)}
        style={{ border: 'none', width: '100%', minHeight: 480 }}
        aria-label={rt(_, sdkMessages.signInForm)}
      />
    </div>
  )
}
