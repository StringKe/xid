export const INSTANCE_CONSOLE_ROUTE_CHECKS = [
  {
    path: '/console',
    expectedPathPrefix: '/console/org',
    expectedText: 'Key metrics',
  },
  {
    path: '/console/managed-projects',
    expectedPathPrefix: '/console/managed-projects',
    expectedText: 'Managed projects',
  },
  {
    path: '/console/users',
    expectedPathPrefix: '/console/org/members',
    expectedText: 'Members',
  },
  {
    path: '/console/organizations',
    expectedPathPrefix: '/console/org',
    expectedText: 'Key metrics',
  },
  {
    path: '/console/settings',
    expectedPathPrefix: '/console/settings',
    expectedText: 'Settings',
  },
]

export const ORGANIZATION_CONSOLE_ROUTE_CHECKS = [
  { path: '/console/org', expectedText: 'Key metrics' },
  { path: '/console/org/members', expectedText: 'Members' },
  { path: '/console/org/projects', expectedText: 'Projects and access' },
  { path: '/console/org/roles', expectedText: 'Roles and permissions' },
  { path: '/console/org/auth-policy', expectedText: 'Authentication policy' },
  { path: '/console/org/delivery-channels', expectedText: 'Delivery channels' },
  { path: '/console/org/social-providers', expectedText: 'Social providers' },
  { path: '/console/org/sso', expectedText: 'Inbound SSO connections' },
  { path: '/console/org/outbound-sso', expectedText: 'Outbound enterprise SSO' },
  { path: '/console/org/scim', expectedText: 'Directory sync (SCIM)' },
  { path: '/console/org/scim-targets', expectedText: 'SCIM targets' },
  { path: '/console/org/domains', expectedText: 'Domains' },
  { path: '/console/org/branding', expectedText: 'Brand customization' },
  { path: '/console/org/applications', expectedText: 'OAuth applications' },
  { path: '/console/org/webhooks', expectedText: 'Webhooks' },
  { path: '/console/org/api-keys', expectedText: 'API keys' },
  { path: '/console/org/audit-events', expectedText: 'Audit events' },
  { path: '/console/org/compliance', expectedText: 'Compliance center' },
].map((route) => ({ ...route, expectedPathPrefix: route.path }))

export const PLATFORM_CONSOLE_ROUTE_CHECKS = [
  { path: '/console/platform', expectedText: 'Platform overview' },
  { path: '/console/platform/organizations', expectedText: 'Organizations' },
  { path: '/console/platform/users', expectedText: 'Global user search' },
  { path: '/console/platform/managers', expectedText: 'Instance managers' },
  { path: '/console/platform/events', expectedText: 'Global event stream' },
  { path: '/console/platform/flags', expectedText: 'Feature flags' },
  { path: '/console/platform/billing', expectedText: 'Billing overview' },
  {
    path: '/console/platform/plans',
    expectedText: 'Plans and quotas',
    organizationQuery: true,
  },
  { path: '/console/platform/announcements', expectedText: 'Announcements' },
  { path: '/console/platform/status', expectedText: 'Status incidents' },
  { path: '/console/platform/compliance', expectedText: 'Compliance center' },
  { path: '/console/platform/dead-letters', expectedText: 'Dead letters' },
  { path: '/console/platform/settings', expectedText: 'Platform settings' },
].map((route) => ({ ...route, expectedPathPrefix: route.path }))

export const CONSOLE_SPA_ROUTE_CHECKS = [
  ...INSTANCE_CONSOLE_ROUTE_CHECKS,
  ...ORGANIZATION_CONSOLE_ROUTE_CHECKS,
  ...PLATFORM_CONSOLE_ROUTE_CHECKS,
]
