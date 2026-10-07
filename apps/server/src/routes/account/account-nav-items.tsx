import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { AccountIconName } from './account-icons'
import { ACCOUNT_PATHS } from './account-paths'

export type AccountNavItem = {
  to: string
  icon: AccountIconName
  label: ReactNode
}

export const ACCOUNT_NAV_ITEMS: readonly AccountNavItem[] = [
  { to: ACCOUNT_PATHS.profile, icon: 'profile', label: <Trans>Profile</Trans> },
  { to: ACCOUNT_PATHS.security, icon: 'security', label: <Trans>Security</Trans> },
  { to: ACCOUNT_PATHS.devices, icon: 'devices', label: <Trans>Devices</Trans> },
  { to: ACCOUNT_PATHS.organizations, icon: 'organizations', label: <Trans>Organizations</Trans> },
  { to: ACCOUNT_PATHS.privacy, icon: 'privacy', label: <Trans>Data & privacy</Trans> },
]

export function isActiveAccountPath(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}
