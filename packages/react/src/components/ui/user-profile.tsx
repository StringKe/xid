// UserProfile:用户资料面板(对标 Clerk <UserProfile>)。
// 嵌入式展示用户基本信息 + 链接到 Hosted UI account portal。

import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { useXidStore } from '../../hooks/use-xid-store'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'
import { UserAvatar } from './user-avatar'

export type UserProfileProps = {
  // account portal URL(Hosted UI)
  profileUrl?: string
  appearance?: Appearance
  className?: string
}

export function UserProfile({
  profileUrl = '/account',
  appearance,
  className,
}: UserProfileProps): ReactNode {
  const state = useXidStore()
  const { _ } = useLingui()
  const cssVars = buildCssVariables(appearance?.variables)
  const cardClass = cx('xid-user-profile', appearance?.elements?.card, className)

  if (!state.isLoaded) {
    return (
      <div
        className={cardClass}
        style={cssVars as CSSProperties}
        aria-busy="true"
        aria-live="polite"
      >
        <Rt {...sdkMessages.loading} />
      </div>
    )
  }

  if (!state.isSignedIn || !state.user) {
    return null
  }

  const { user } = state

  return (
    <div
      className={cardClass}
      style={cssVars as CSSProperties}
      role="region"
      aria-label={rt(_, sdkMessages.userProfile)}
    >
      <div className={cx('xid-user-profile__header', appearance?.elements?.cardHeader)}>
        <UserAvatar
          imageUrl={user.imageUrl}
          firstName={user.firstName}
          lastName={user.lastName}
          username={user.username}
          size={64}
          appearance={appearance}
        />
        <div className="xid-user-profile__info">
          {user.fullName && <h2 className="xid-user-profile__name">{user.fullName}</h2>}
          {user.primaryEmailAddress && (
            <p className="xid-user-profile__email">{user.primaryEmailAddress}</p>
          )}
          {user.username && <p className="xid-user-profile__username">@{user.username}</p>}
        </div>
      </div>

      <div className={cx('xid-user-profile__footer', appearance?.elements?.cardFooter)}>
        <a
          href={profileUrl}
          className={cx('xid-button xid-button--secondary', appearance?.elements?.buttonSecondary)}
        >
          <Rt {...sdkMessages.manageProfile} />
        </a>
      </div>
    </div>
  )
}
