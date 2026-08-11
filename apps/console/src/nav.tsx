// 侧栏导航唯一事实源;Settings 等入口页也从这里派生,新增页只改此处。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'

// groupKey 用稳定 string 分组(ReactNode 不能 ===);无 key 则不分组。权限过滤在 route 层做。
export type ConsoleNavItem = {
  to: string
  label: ReactNode
  end?: boolean
  groupKey?: string
  groupLabel?: ReactNode
}

export const CONSOLE_NAV: readonly ConsoleNavItem[] = [
  { to: '/console', label: <Trans>Overview</Trans>, end: true },
  { to: '/console/managed-projects', label: <Trans>Managed projects</Trans> },
  { to: '/console/users', label: <Trans>Users</Trans> },
  { to: '/console/organizations', label: <Trans>Organizations</Trans> },
  { to: '/console/settings', label: <Trans>Settings</Trans> },
]

export const ORG_NAV: readonly ConsoleNavItem[] = [
  { to: '/console/org', label: <Trans>Overview</Trans>, end: true },
  {
    to: '/console/org/auth-policy',
    label: <Trans>Auth policy</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/social-providers',
    label: <Trans>Social providers</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/sso',
    label: <Trans>Inbound SSO</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/outbound-sso',
    label: <Trans>Outbound SSO</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/scim',
    label: <Trans>Directory sync</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/scim-targets',
    label: <Trans>SCIM targets</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/delivery-channels',
    label: <Trans>Delivery channels</Trans>,
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/applications',
    label: <Trans>Applications</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/projects',
    label: <Trans>Projects</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/roles',
    label: <Trans>Roles and permissions</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/api-keys',
    label: <Trans>API keys</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/webhooks',
    label: <Trans>Webhooks</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/domains',
    label: <Trans>Domains</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/branding',
    label: <Trans>Branding</Trans>,
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/members',
    label: <Trans>Members</Trans>,
    groupKey: 'people',
    groupLabel: <Trans>People</Trans>,
  },
  {
    to: '/console/org/audit-events',
    label: <Trans>Audit events</Trans>,
    groupKey: 'activity',
    groupLabel: <Trans>Activity</Trans>,
  },
  {
    to: '/console/org/compliance',
    label: <Trans>Compliance</Trans>,
    groupKey: 'activity',
    groupLabel: <Trans>Activity</Trans>,
  },
]

export const PLATFORM_NAV: readonly ConsoleNavItem[] = [
  { to: '/console/platform', label: <Trans>Overview</Trans>, end: true },
  {
    to: '/console/platform/organizations',
    label: <Trans>Organizations</Trans>,
    groupKey: 'directory',
    groupLabel: <Trans>Directory</Trans>,
  },
  {
    to: '/console/platform/users',
    label: <Trans>Users</Trans>,
    groupKey: 'directory',
    groupLabel: <Trans>Directory</Trans>,
  },
  {
    to: '/console/platform/managers',
    label: <Trans>Instance managers</Trans>,
    groupKey: 'directory',
    groupLabel: <Trans>Directory</Trans>,
  },
  {
    to: '/console/platform/events',
    label: <Trans>Event stream</Trans>,
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/flags',
    label: <Trans>Feature flags</Trans>,
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/status',
    label: <Trans>Status incidents</Trans>,
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/dead-letters',
    label: <Trans>Dead letters</Trans>,
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/announcements',
    label: <Trans>Announcements</Trans>,
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/compliance',
    label: <Trans>Compliance</Trans>,
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/billing',
    label: <Trans>Billing</Trans>,
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/plans',
    label: <Trans>Plans and quotas</Trans>,
    groupKey: 'billing',
    groupLabel: <Trans>Billing</Trans>,
  },
  { to: '/console/platform/settings', label: <Trans>Settings</Trans> },
]
