export type ConsoleRouteScope = 'instance' | 'organization' | 'platform'

export type ConsoleRouteEntry = {
  path: string
  label: string
  scope: ConsoleRouteScope
  description: string
}

export const INSTANCE_CONSOLE_ROUTES: readonly ConsoleRouteEntry[] = [
  {
    path: '/console',
    label: 'Overview',
    scope: 'instance',
    description: 'Instance-level console overview.',
  },
  {
    path: '/console/users',
    label: 'Users',
    scope: 'instance',
    description: 'Pick an organization to manage members.',
  },
  {
    path: '/console/organizations',
    label: 'Organizations',
    scope: 'instance',
    description: 'Browse organizations you can administer.',
  },
  {
    path: '/console/sessions',
    label: 'Sessions',
    scope: 'instance',
    description: 'Review and revoke active sessions.',
  },
  {
    path: '/console/security',
    label: 'Security',
    scope: 'instance',
    description: 'Manage MFA, passkeys, and security settings.',
  },
  {
    path: '/console/settings',
    label: 'Settings',
    scope: 'instance',
    description: 'Account and console preferences.',
  },
] as const

export const ORGANIZATION_CONSOLE_ROUTES: readonly ConsoleRouteEntry[] = [
  {
    path: '/console/org',
    label: 'Overview',
    scope: 'organization',
    description: 'Organization overview and stats.',
  },
  {
    path: '/console/org/auth-policy',
    label: 'Auth policy',
    scope: 'organization',
    description: 'Password, MFA, and session policy.',
  },
  {
    path: '/console/org/social-providers',
    label: 'Social providers',
    scope: 'organization',
    description: 'Social login provider configuration.',
  },
  {
    path: '/console/org/sso',
    label: 'Inbound SSO',
    scope: 'organization',
    description: 'Enterprise IdP connections.',
  },
  {
    path: '/console/org/outbound-sso',
    label: 'Outbound SSO',
    scope: 'organization',
    description: 'SAML apps for downstream SaaS.',
  },
  {
    path: '/console/org/scim',
    label: 'Directory sync',
    scope: 'organization',
    description: 'Inbound SCIM directories.',
  },
  {
    path: '/console/org/scim-targets',
    label: 'SCIM targets',
    scope: 'organization',
    description: 'Outbound SCIM provisioning targets.',
  },
  {
    path: '/console/org/delivery-channels',
    label: 'Delivery channels',
    scope: 'organization',
    description: 'Email and SMS delivery configuration.',
  },
  {
    path: '/console/org/applications',
    label: 'Applications',
    scope: 'organization',
    description: 'OAuth/OIDC client applications.',
  },
  {
    path: '/console/org/api-keys',
    label: 'API keys',
    scope: 'organization',
    description: 'Management API secret keys.',
  },
  {
    path: '/console/org/webhooks',
    label: 'Webhooks',
    scope: 'organization',
    description: 'Webhook endpoints and signing secrets metadata.',
  },
  {
    path: '/console/org/domains',
    label: 'Domains',
    scope: 'organization',
    description: 'Custom domains and hostname verification.',
  },
  {
    path: '/console/org/branding',
    label: 'Branding',
    scope: 'organization',
    description: 'Hosted UI branding and theme.',
  },
  {
    path: '/console/org/members',
    label: 'Members',
    scope: 'organization',
    description: 'Organization members and invitations.',
  },
  {
    path: '/console/org/roles',
    label: 'Roles',
    scope: 'organization',
    description: 'Roles and permissions.',
  },
  {
    path: '/console/org/audit-events',
    label: 'Audit events',
    scope: 'organization',
    description: 'Organization audit log.',
  },
] as const

export const PLATFORM_CONSOLE_ROUTES: readonly ConsoleRouteEntry[] = [
  {
    path: '/console/platform',
    label: 'Overview',
    scope: 'platform',
    description: 'Instance manager platform overview.',
  },
  {
    path: '/console/platform/organizations',
    label: 'Organizations',
    scope: 'platform',
    description: 'Cross-tenant organization administration.',
  },
  {
    path: '/console/platform/users',
    label: 'Users',
    scope: 'platform',
    description: 'Cross-tenant user search.',
  },
  {
    path: '/console/platform/events',
    label: 'Event stream',
    scope: 'platform',
    description: 'Platform-wide audit event stream.',
  },
  {
    path: '/console/platform/flags',
    label: 'Feature flags',
    scope: 'platform',
    description: 'Instance feature flag management.',
  },
  {
    path: '/console/platform/billing',
    label: 'Billing',
    scope: 'platform',
    description: 'Usage and billing views.',
  },
  {
    path: '/console/platform/settings',
    label: 'Settings',
    scope: 'platform',
    description: 'Instance-level platform settings.',
  },
] as const

export function listConsoleRoutesForUser(options: {
  instanceManager: boolean
}): readonly ConsoleRouteEntry[] {
  if (options.instanceManager) {
    return [...INSTANCE_CONSOLE_ROUTES, ...ORGANIZATION_CONSOLE_ROUTES, ...PLATFORM_CONSOLE_ROUTES]
  }
  return [...INSTANCE_CONSOLE_ROUTES, ...ORGANIZATION_CONSOLE_ROUTES]
}

export function isAllowedConsolePath(path: string): boolean {
  const routes = [
    ...INSTANCE_CONSOLE_ROUTES,
    ...ORGANIZATION_CONSOLE_ROUTES,
    ...PLATFORM_CONSOLE_ROUTES,
  ]
  return routes.some((route) => route.path === path)
}
