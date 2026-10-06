// Worker 实际发出的 webhook 事件名。新增事件时同步更新此表与 docs/design/06 第 7 节。
export const WEBHOOK_EVENT_TYPES = [
  'user.created',
  'user.updated',
  'user.deleted',
  'user.restored',
  'user.banned',
  'user.unbanned',
  'user.deactivated',
  'organization.created',
  'organization.updated',
  'organization.deleted',
  'organization.restored',
  'organization.auth_policy.updated',
  'organization.delivery_channels.updated',
  'organization.social_providers.updated',
  'organization.outbound_saml_app.created',
  'organization.outbound_saml_app.deleted',
  'organization.scim_target.created',
  'organization.scim_target.deleted',
  'organizationMembership.created',
  'organizationMembership.updated',
  'organizationMembership.deleted',
  'organizationMembership.restored',
  'organizationInvitation.created',
  'organizationInvitation.accepted',
  'organizationInvitation.revoked',
  'connection.saml_certificate_renewed',
] as const

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]

function eventObject(event: string): string {
  return event.split('.')[0] ?? ''
}

export const WEBHOOK_EVENT_OBJECTS: readonly string[] = [
  ...new Set(WEBHOOK_EVENT_TYPES.map(eventObject)),
]

// 订阅项只允许 `*`、已发出的事件名或 `<object>.*`。
export function isWebhookSubscription(value: string): boolean {
  if (value === '*') return true
  if ((WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)) return true
  return value.endsWith('.*') && WEBHOOK_EVENT_OBJECTS.includes(value.slice(0, -2))
}

// 空订阅表示接收全部事件。
export function webhookSubscriptionMatches(types: readonly string[], event: string): boolean {
  if (types.length === 0) return true
  const object = eventObject(event)
  return types.some((type) => type === '*' || type === event || type === `${object}.*`)
}

// API key scope 的资源白名单,`resource:read` / `resource:write` / `resource:*` 与 `*` 合法。
export const API_KEY_SCOPE_RESOURCES = [
  'access-requests',
  'api_keys',
  'applications',
  'audit_events',
  'branding',
  'connections',
  'custom_hostnames',
  'directories',
  'invitations',
  'memberships',
  'organization_domains',
  'organizations',
  'org-units',
  'permissions',
  'projects',
  'project_grants',
  'role_permissions',
  'roles',
  'sessions',
  'manager_assignments',
  'user_grants',
  'users',
  'webhooks',
] as const

export type ApiKeyScopeResource = (typeof API_KEY_SCOPE_RESOURCES)[number]

export const API_KEY_ENVIRONMENTS = ['live', 'test'] as const
export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number]
