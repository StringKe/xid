import type { ReactNode, CSSProperties } from 'react'

import { useLingui } from '@lingui/react'

import type { Appearance } from '../../appearance'
import { buildCssVariables, cx } from '../../appearance'
import { rt, sdkMessages } from '../../i18n-runtime'

export type UserAvatarProps = {
  imageUrl?: string | null
  firstName?: string | null
  lastName?: string | null
  username?: string | null
  size?: number
  appearance?: Appearance
  className?: string
}

function getInitials(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  username: string | null | undefined,
): string {
  if (firstName && lastName) return `${firstName[0]}${lastName[0]}`.toUpperCase()
  if (firstName) return firstName[0]!.toUpperCase()
  if (lastName) return lastName[0]!.toUpperCase()
  if (username) return username[0]!.toUpperCase()
  return '?'
}

export function UserAvatar({
  imageUrl,
  firstName,
  lastName,
  username,
  size = 32,
  appearance,
  className,
}: UserAvatarProps): ReactNode {
  const { _ } = useLingui()
  const cssVars = buildCssVariables(appearance?.variables)
  const avatarClass = cx('xid-user-avatar', appearance?.elements?.userAvatar, className)
  const style: CSSProperties = {
    ...cssVars,
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  }

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={firstName ?? username ?? rt(_, sdkMessages.userAvatar)}
        width={size}
        height={size}
        className={avatarClass}
        style={style}
        aria-hidden={false}
      />
    )
  }

  const initials = getInitials(firstName, lastName, username)
  const label = firstName
    ? `${firstName}${lastName ? ` ${lastName}` : ''}`
    : (username ?? rt(_, sdkMessages.user))

  return (
    <span
      className={avatarClass}
      style={{ ...style, fontSize: size * 0.4, fontWeight: 600 }}
      role="img"
      aria-label={label}
    >
      {initials}
    </span>
  )
}
