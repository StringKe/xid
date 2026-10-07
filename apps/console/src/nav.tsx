// 侧栏导航唯一事实源;Settings 入口页、移动菜单与命令菜单的页面跳转都从这里派生,新增页只改此处。

import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { IconName } from '@xid-kit/web-ui/ui'

// 文案用惰性 descriptor:侧栏渲染和命令菜单的纯文本检索共用一份。测试可直接传字符串。
export type NavLabel = MessageDescriptor | string

// groupKey 用稳定 string 分组;无 key 的项各自独段。分组标签是 sentence case 的不可折叠标题。
// 侧栏不画图标(反 AI 味清单 11);icon 只给 Settings 入口页使用。
export type ConsoleNavItem = {
  to: string
  label: NavLabel
  icon?: IconName
  end?: boolean
  groupKey?: string
  groupLabel?: NavLabel
  // 整个租户共享的资源,只在顶层组织下显示。
  tenantScope?: boolean
}

// 受托 Project 不属于任何 org 视角,ConsoleLayout 在有 manager assignment 时把它补进侧栏。
export const MANAGED_PROJECTS_NAV_ITEM: ConsoleNavItem = {
  to: '/console/managed-projects',
  label: msg`Managed projects`,
  icon: 'folder',
}

export const CONSOLE_NAV: readonly ConsoleNavItem[] = [
  { to: '/console', label: msg`Overview`, icon: 'gauge', end: true },
  MANAGED_PROJECTS_NAV_ITEM,
  { to: '/console/users', label: msg`Users`, icon: 'users' },
  { to: '/console/organizations', label: msg`Organizations`, icon: 'building' },
  { to: '/console/settings', label: msg`Settings`, icon: 'gear' },
]

export const ORG_OVERVIEW_PATH = '/console/org'
export const ORG_USERS_PATH = '/console/org/users'
export const ORG_MEMBERS_PATH = '/console/org/members'
export const ORG_PROJECTS_PATH = '/console/org/projects'
export const ORG_APPLICATIONS_PATH = '/console/org/applications'

const users = { groupKey: 'users', groupLabel: msg`Users` }
const applications = { groupKey: 'applications', groupLabel: msg`Applications` }
const authentication = { groupKey: 'authentication', groupLabel: msg`Authentication` }
const directory = { groupKey: 'directory', groupLabel: msg`Directory` }
const customization = { groupKey: 'customization', groupLabel: msg`Customization` }
const developers = { groupKey: 'developers', groupLabel: msg`Developers` }
const monitoring = { groupKey: 'monitoring', groupLabel: msg`Monitoring` }

export const ORG_NAV: readonly ConsoleNavItem[] = [
  { to: ORG_OVERVIEW_PATH, label: msg`Overview`, icon: 'gauge', end: true },
  { to: ORG_USERS_PATH, label: msg`Users`, icon: 'users', tenantScope: true, ...users },
  { to: ORG_MEMBERS_PATH, label: msg`Members`, icon: 'user-circle', ...users },
  { to: ORG_PROJECTS_PATH, label: msg`Projects`, icon: 'folder', ...applications },
  {
    to: ORG_APPLICATIONS_PATH,
    label: msg`Applications`,
    icon: 'squares-four',
    tenantScope: true,
    ...applications,
  },
  {
    to: '/console/org/outbound-sso',
    label: msg`SAML apps`,
    icon: 'arrow-up-right',
    ...applications,
  },
  {
    to: '/console/org/auth-policy',
    label: msg`Sign-in & MFA`,
    icon: 'fingerprint',
    ...authentication,
  },
  {
    to: '/console/org/social-providers',
    label: msg`Social login`,
    icon: 'plug',
    ...authentication,
  },
  { to: '/console/org/sso', label: msg`Enterprise SSO`, icon: 'key', ...authentication },
  {
    to: '/console/org/delivery-channels',
    label: msg`Messaging`,
    icon: 'megaphone',
    ...authentication,
  },
  { to: '/console/org/scim', label: msg`Directory sync`, icon: 'arrows-left-right', ...directory },
  { to: '/console/org/scim-targets', label: msg`Provisioning`, icon: 'package', ...directory },
  { to: '/console/org/branding', label: msg`Branding`, icon: 'palette', ...customization },
  { to: '/console/org/domains', label: msg`Domains`, icon: 'globe', ...customization },
  {
    to: '/console/org/api-keys',
    label: msg`API keys`,
    icon: 'key',
    tenantScope: true,
    ...developers,
  },
  {
    to: '/console/org/webhooks',
    label: msg`Webhooks`,
    icon: 'webhook',
    tenantScope: true,
    ...developers,
  },
  { to: '/console/org/audit-events', label: msg`Audit log`, icon: 'scroll', ...monitoring },
  {
    to: '/console/org/compliance',
    label: msg`Compliance`,
    icon: 'seal-check',
    tenantScope: true,
    ...monitoring,
  },
]

const platformDirectory = { groupKey: 'directory', groupLabel: msg`Directory` }
const platformOperations = { groupKey: 'operations', groupLabel: msg`Operations` }

export const PLATFORM_NAV: readonly ConsoleNavItem[] = [
  { to: '/console/platform', label: msg`Overview`, icon: 'gauge', end: true },
  {
    to: '/console/platform/organizations',
    label: msg`Organizations`,
    icon: 'building',
    ...platformDirectory,
  },
  { to: '/console/platform/users', label: msg`Users`, icon: 'users', ...platformDirectory },
  {
    to: '/console/platform/managers',
    label: msg`Instance managers`,
    icon: 'user-circle',
    ...platformDirectory,
  },
  {
    to: '/console/platform/events',
    label: msg`Event stream`,
    icon: 'scroll',
    ...platformOperations,
  },
  {
    to: '/console/platform/status',
    label: msg`Status incidents`,
    icon: 'list-status',
    ...platformOperations,
  },
  {
    to: '/console/platform/dead-letters',
    label: msg`Dead letters`,
    icon: 'list-status',
    ...platformOperations,
  },
  {
    to: '/console/platform/announcements',
    label: msg`Announcements`,
    icon: 'megaphone',
    ...platformOperations,
  },
  {
    to: '/console/platform/compliance',
    label: msg`Compliance`,
    icon: 'seal-check',
    ...platformOperations,
  },
  {
    to: '/console/platform/billing',
    label: msg`Billing`,
    icon: 'credit-card',
    ...platformOperations,
  },
  {
    to: '/console/platform/plans',
    label: msg`Plans and quotas`,
    icon: 'package',
    groupKey: 'billing',
    groupLabel: msg`Billing`,
  },
  { to: '/console/platform/settings', label: msg`Settings`, icon: 'gear' },
]
