// 侧栏导航唯一事实源;Settings 等入口页也从这里派生,新增页只改此处。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { IconName } from '@xid-kit/web-ui/ui'

// groupKey 用稳定 string 分组(ReactNode 不能 ===);无 key 则不分组。权限过滤在 route 层做。
// icon 来自 web-ui 内联图标集,侧栏项按"图标+文字"渲染;入口页(如 Settings)复用同一图标。
export type ConsoleNavItem = {
  to: string
  label: ReactNode
  icon?: IconName
  end?: boolean
  groupKey?: string
  groupLabel?: ReactNode
  // 整个租户共享的资源,只在顶层组织下显示。
  tenantScope?: boolean
}

// 受托 Project 不属于任何 org 视角,ConsoleLayout 在有 manager assignment 时把它补进每个侧栏。
export const MANAGED_PROJECTS_NAV_ITEM: ConsoleNavItem = {
  to: '/console/managed-projects',
  label: <Trans>Managed projects</Trans>,
  icon: 'folder',
}

export const CONSOLE_NAV: readonly ConsoleNavItem[] = [
  { to: '/console', label: <Trans>Overview</Trans>, icon: 'gauge', end: true },
  MANAGED_PROJECTS_NAV_ITEM,
  { to: '/console/users', label: <Trans>Users</Trans>, icon: 'users' },
  { to: '/console/organizations', label: <Trans>Organizations</Trans>, icon: 'building' },
  { to: '/console/settings', label: <Trans>Settings</Trans>, icon: 'gear' },
]

export const ORG_NAV: readonly ConsoleNavItem[] = [
  { to: '/console/org', label: <Trans>Overview</Trans>, icon: 'gauge', end: true },
  {
    to: '/console/org/auth-policy',
    label: <Trans>Auth policy</Trans>,
    icon: 'fingerprint',
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/social-providers',
    label: <Trans>Social providers</Trans>,
    icon: 'plug',
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/sso',
    label: <Trans>Inbound SSO</Trans>,
    icon: 'key',
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/outbound-sso',
    label: <Trans>Outbound SSO</Trans>,
    icon: 'arrow-up-right',
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/scim',
    label: <Trans>Directory sync</Trans>,
    icon: 'arrows-left-right',
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/scim-targets',
    label: <Trans>SCIM targets</Trans>,
    icon: 'package',
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/delivery-channels',
    label: <Trans>Delivery channels</Trans>,
    icon: 'megaphone',
    groupKey: 'authentication',
    groupLabel: <Trans>Authentication</Trans>,
  },
  {
    to: '/console/org/projects',
    label: <Trans>Projects</Trans>,
    icon: 'folder',
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/roles',
    label: <Trans>Roles and permissions</Trans>,
    icon: 'shield-check',
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/domains',
    label: <Trans>Domains</Trans>,
    icon: 'globe',
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/branding',
    label: <Trans>Branding</Trans>,
    icon: 'palette',
    groupKey: 'resources',
    groupLabel: <Trans>Resources</Trans>,
  },
  {
    to: '/console/org/members',
    label: <Trans>Members</Trans>,
    icon: 'users',
    groupKey: 'people',
    groupLabel: <Trans>People</Trans>,
  },
  {
    to: '/console/org/audit-events',
    label: <Trans>Audit events</Trans>,
    icon: 'scroll',
    groupKey: 'activity',
    groupLabel: <Trans>Activity</Trans>,
  },
  {
    to: '/console/org/applications',
    label: <Trans>Applications</Trans>,
    icon: 'squares-four',
    groupKey: 'tenant',
    groupLabel: <Trans>Tenant settings</Trans>,
    tenantScope: true,
  },
  {
    to: '/console/org/api-keys',
    label: <Trans>API keys</Trans>,
    icon: 'key',
    groupKey: 'tenant',
    groupLabel: <Trans>Tenant settings</Trans>,
    tenantScope: true,
  },
  {
    to: '/console/org/webhooks',
    label: <Trans>Webhooks</Trans>,
    icon: 'webhook',
    groupKey: 'tenant',
    groupLabel: <Trans>Tenant settings</Trans>,
    tenantScope: true,
  },
  {
    to: '/console/org/compliance',
    label: <Trans>Compliance</Trans>,
    icon: 'seal-check',
    groupKey: 'tenant',
    groupLabel: <Trans>Tenant settings</Trans>,
    tenantScope: true,
  },
]

export const PLATFORM_NAV: readonly ConsoleNavItem[] = [
  { to: '/console/platform', label: <Trans>Overview</Trans>, icon: 'gauge', end: true },
  {
    to: '/console/platform/organizations',
    label: <Trans>Organizations</Trans>,
    icon: 'building',
    groupKey: 'directory',
    groupLabel: <Trans>Directory</Trans>,
  },
  {
    to: '/console/platform/users',
    label: <Trans>Users</Trans>,
    icon: 'users',
    groupKey: 'directory',
    groupLabel: <Trans>Directory</Trans>,
  },
  {
    to: '/console/platform/managers',
    label: <Trans>Instance managers</Trans>,
    icon: 'user-circle',
    groupKey: 'directory',
    groupLabel: <Trans>Directory</Trans>,
  },
  {
    to: '/console/platform/events',
    label: <Trans>Event stream</Trans>,
    icon: 'scroll',
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/status',
    label: <Trans>Status incidents</Trans>,
    icon: 'list-status',
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/dead-letters',
    label: <Trans>Dead letters</Trans>,
    icon: 'list-status',
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/announcements',
    label: <Trans>Announcements</Trans>,
    icon: 'megaphone',
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/compliance',
    label: <Trans>Compliance</Trans>,
    icon: 'seal-check',
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/billing',
    label: <Trans>Billing</Trans>,
    icon: 'credit-card',
    groupKey: 'operations',
    groupLabel: <Trans>Operations</Trans>,
  },
  {
    to: '/console/platform/plans',
    label: <Trans>Plans and quotas</Trans>,
    icon: 'package',
    groupKey: 'billing',
    groupLabel: <Trans>Billing</Trans>,
  },
  { to: '/console/platform/settings', label: <Trans>Settings</Trans>, icon: 'gear' },
]
