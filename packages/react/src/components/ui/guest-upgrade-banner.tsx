// GuestUpgradeBanner:guest 用户的转正引导条(对标 Firebase anonymous upgrade 提示)。
// 仅当已登录且用户匿名开通(provisionedBy === 'anonymous')时渲染,其余情况渲染 null。
// 文案走 lingui runtime descriptor;无样式,class 走 xid-guest-upgrade-banner 命名约定。

import type { CSSProperties, ReactNode } from 'react'

import { isGuestUser } from '@xid-kit/core'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { useXidStore } from '../../hooks/use-xid-store'
import { Rt, sdkMessages } from '../../i18n-runtime'
import { runAuthorizationRedirect } from '../control/authorization-redirect'

export type GuestUpgradeBannerProps = {
  // 转正入口(Hosted UI 注册/设置登录方式页)
  upgradeUrl?: string
  // 转正完成后回跳地址
  redirectUrl?: string
  appearance?: Appearance
  className?: string
  onError?: (error: unknown) => void
}

export function GuestUpgradeBanner({
  upgradeUrl = '/sign-up',
  redirectUrl,
  appearance,
  className,
  onError,
}: GuestUpgradeBannerProps): ReactNode {
  const { client, mode } = useXidContext()
  const state = useXidStore()
  const cssVars = buildCssVariables(appearance?.variables)

  if (!state.isLoaded || !state.isSignedIn || !isGuestUser(state.user)) return null

  return (
    <div
      className={cx('xid-guest-upgrade-banner', className)}
      style={cssVars as CSSProperties}
      role="status"
    >
      <span className="xid-guest-upgrade-banner__message">
        <Rt {...sdkMessages.guestUpgradeMessage} />
      </span>
      <button
        type="button"
        className="xid-guest-upgrade-banner__action"
        onClick={() =>
          runAuthorizationRedirect(
            {
              client,
              mode,
              intent: 'sign-up',
              ...(redirectUrl ? { returnUrl: redirectUrl } : {}),
              sameOriginPath: upgradeUrl,
            },
            onError,
          )
        }
      >
        <Rt {...sdkMessages.guestUpgradeAction} />
      </button>
    </div>
  )
}
