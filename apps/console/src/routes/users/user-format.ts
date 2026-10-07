// 用户相关的展示文案与时间格式:状态、登录方式、显示名、相对时间。日期一律按当前 locale 格式化。

import { msg } from '@lingui/core/macro'
import type { I18n, MessageDescriptor } from '@lingui/core'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import type { ConsoleUser, SignInMethod, UserStatus } from './user-api'

const STATUS_LABELS: Record<UserStatus, MessageDescriptor> = {
  active: msg`Active`,
  banned: msg`Suspended`,
  deleted: msg`Deleted`,
}

const STATUS_TONES: Record<UserStatus, BadgeTone> = {
  active: 'success',
  banned: 'danger',
  deleted: 'neutral',
}

export function statusBadge(
  i18n: I18n,
  status: UserStatus,
  isGuest: boolean,
): { label: string; tone: BadgeTone } {
  if (isGuest && status === 'active') return { label: i18n._(msg`Guest`), tone: 'neutral' }
  return { label: i18n._(STATUS_LABELS[status]), tone: STATUS_TONES[status] }
}

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  microsoft: 'Microsoft',
  apple: 'Apple',
  facebook: 'Facebook',
  gitlab: 'GitLab',
  linkedin: 'LinkedIn',
  slack: 'Slack',
  discord: 'Discord',
  twitter: 'X',
  x: 'X',
}

export function providerName(provider: string | null | undefined): string | null {
  if (!provider) return null
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider
}

export function signInMethodLabel(i18n: I18n, method: SignInMethod): string {
  switch (method.type) {
    case 'password':
      return i18n._(msg`Password`)
    case 'passkey':
      return i18n._(msg`Passkey`)
    case 'guest':
      return i18n._(msg`Guest session`)
    case 'social':
      return providerName(method.provider) ?? i18n._(msg`Social login`)
    case 'sso':
      return i18n._(msg`Enterprise SSO`)
  }
}

export function signInMethodsText(i18n: I18n, methods: readonly SignInMethod[]): string | null {
  const labels = [...new Set(methods.map((method) => signInMethodLabel(i18n, method)))]
  return labels.length > 0
    ? new Intl.ListFormat(i18n.locale, { style: 'narrow' }).format(labels)
    : null
}

export function isGuestUser(user: {
  signInMethods?: readonly SignInMethod[]
  isGuest?: boolean
}): boolean {
  return (
    user.isGuest === true || (user.signInMethods ?? []).some((method) => method.type === 'guest')
  )
}

export function userDisplayName(
  i18n: I18n,
  user: Pick<ConsoleUser, 'id' | 'displayName' | 'firstName' | 'lastName' | 'username'> & {
    primaryEmail?: string | null
    primaryPhone?: string | null
  },
  guest = false,
): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ')
  const name = user.displayName || full || user.username
  if (name) return name
  if (guest) {
    const tag = user.id.slice(-4).toUpperCase()
    return i18n._(msg`Guest ${tag}`)
  }
  return user.primaryEmail ?? user.primaryPhone ?? user.id
}

export function formatDate(i18n: I18n, value: string | null | undefined): string | null {
  if (!value) return null
  return i18n.date(new Date(value), { dateStyle: 'medium' })
}

export function formatDateTime(i18n: I18n, value: string | null | undefined): string | null {
  if (!value) return null
  return i18n.date(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// 一分钟内「Just now」,一小时内按分钟,一天内按小时,昨天,一周内按天,再早显示日期。
export function formatRelative(
  i18n: I18n,
  value: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!value) return null
  const elapsed = now - new Date(value).getTime()
  const relative = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' })
  if (elapsed < MINUTE) return i18n._(msg`Just now`)
  if (elapsed < HOUR) return relative.format(-Math.round(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return relative.format(-Math.round(elapsed / HOUR), 'hour')
  if (elapsed < 7 * DAY) return relative.format(-Math.round(elapsed / DAY), 'day')
  return i18n.date(new Date(value), { month: 'short', day: 'numeric' })
}
