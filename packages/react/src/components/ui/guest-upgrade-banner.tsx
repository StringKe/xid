// 仅 isGuestUser(provisionedBy === 'anonymous') 时渲染。

import type { CSSProperties, ReactNode } from 'react'

import { isGuestUser } from '@xid-kit/core'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidContext } from '../../context/xid-context'
import { useXidStore } from '../../hooks/use-xid-store'
import { Rt, sdkMessages } from '../../i18n-runtime'
import { runAuthorizationRedirect } from '../control/authorization-redirect'

export type GuestUpgradeBannerProps = {
  upgradeUrl?: string
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
