import type { ApiClient } from '@xid-kit/web-ui/api'
import type { AuthOrg, AuthUser, MeResponse } from '@xid-kit/web-ui/session'
import { isAllowedConsolePath, listConsoleRoutesForUser } from './console-routes'
import type { WebMcpToolDefinition } from './types'

export type RegisterConsoleWebMcpToolsOptions = {
  navigate: (to: string) => void
  getPathname?: () => string
  getPageTitle?: () => string
  api: ApiClient
  me: MeResponse
  setActiveOrganization: (organizationId: string | null) => Promise<boolean>
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function readStringProperty(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}

function sanitizeUser(user: AuthUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    locale: user.locale,
    hasMfa: user.hasMfa,
    instanceManager: user.instanceManager,
  }
}

function sanitizeOrg(org: AuthOrg): Record<string, unknown> {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    role: org.role,
    permissions: org.permissions,
  }
}

async function apiGet<T>(api: ApiClient, path: string): Promise<string> {
  const result = await api.get<T>(path)
  if (!result.ok) {
    return jsonResult({ error: result.error.code, httpStatus: result.error.httpStatus })
  }
  return jsonResult(result.value)
}

function resolveOrgId(me: MeResponse, input: Record<string, unknown>): string | null {
  const requested = readStringProperty(input, 'organizationId')
  if (requested) return requested
  return me.activeOrg?.id ?? null
}

export function createConsoleShellWebMcpTools(
  options: Pick<RegisterConsoleWebMcpToolsOptions, 'navigate' | 'getPathname' | 'getPageTitle'>,
): WebMcpToolDefinition[] {
  const getPathname = options.getPathname ?? (() => location.pathname)
  const getPageTitle = options.getPageTitle ?? (() => document.title)

  return [
    {
      name: 'get_console_context',
      description: 'Return the current XID management console page context.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () =>
        jsonResult({
          pathname: getPathname(),
          pageTitle: getPageTitle(),
          surface: 'management-console',
          authenticated: false,
          message:
            'Sign in is required before console management tools can access organization data.',
        }),
    },
    {
      name: 'list_console_routes',
      description:
        'List published management console routes. Full data tools unlock after sign-in.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () =>
        jsonResult({
          routes: listConsoleRoutesForUser({ instanceManager: false }),
          authenticated: false,
        }),
    },
    {
      name: 'navigate_to_console',
      description: 'Navigate the visible browser tab to an allowed XID management console route.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Console path such as /console or /console/org/members.',
          },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const path = readStringProperty(input, 'path')
        if (!path) return jsonResult({ error: 'path is required' })

        const normalized = path.startsWith('/') ? path : `/${path}`
        if (!isAllowedConsolePath(normalized)) {
          return jsonResult({ error: 'path is not an allowed console route', path: normalized })
        }

        options.navigate(normalized)
        return jsonResult({ navigated: true, path: normalized })
      },
    },
  ]
}

export function createConsoleWebMcpTools(
  options: RegisterConsoleWebMcpToolsOptions,
): WebMcpToolDefinition[] {
  const getPathname = options.getPathname ?? (() => location.pathname)
  const getPageTitle = options.getPageTitle ?? (() => document.title)
  const { me, api } = options

  return [
    {
      name: 'get_console_context',
      description:
        'Return the current XID management console page context, signed-in user summary, active organization, and accessible console route scopes.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () =>
        jsonResult({
          pathname: getPathname(),
          pageTitle: getPageTitle(),
          surface: 'management-console',
          user: me.user ? sanitizeUser(me.user) : null,
          activeOrg: me.activeOrg ? sanitizeOrg(me.activeOrg) : null,
          organizations: me.organizations.map(sanitizeOrg),
          sessionStatus: me.session?.status ?? null,
        }),
    },
    {
      name: 'list_console_routes',
      description:
        'List management console routes available to the signed-in user, including instance, organization, and platform scopes.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () =>
        jsonResult({
          routes: listConsoleRoutesForUser({
            instanceManager: me.user?.instanceManager ?? false,
          }),
        }),
    },
    {
      name: 'navigate_to_console',
      description:
        'Navigate the visible browser tab to an allowed XID management console route. Rejects unknown or auth-only paths.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Console path such as /console/org/members or /console/platform/users.',
          },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const path = readStringProperty(input, 'path')
        if (!path) return jsonResult({ error: 'path is required' })

        const normalized = path.startsWith('/') ? path : `/${path}`
        if (!isAllowedConsolePath(normalized)) {
          return jsonResult({ error: 'path is not an allowed console route', path: normalized })
        }

        options.navigate(normalized)
        return jsonResult({ navigated: true, path: normalized })
      },
    },
    {
      name: 'switch_active_organization',
      description:
        'Switch the signed-in session active organization context. Pass organizationId or null to clear org context.',
      inputSchema: {
        type: 'object',
        properties: {
          organizationId: {
            type: 'string',
            description:
              'Target organization id from list_accessible_organizations, or omit with null to clear.',
          },
        },
      },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const organizationId = readStringProperty(input, 'organizationId')
        const ok = await options.setActiveOrganization(organizationId)
        return jsonResult({ switched: ok, organizationId })
      },
    },
    {
      name: 'list_accessible_organizations',
      description: 'List organizations the signed-in user can access in the management console.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => jsonResult({ organizations: me.organizations.map(sanitizeOrg) }),
    },
    {
      name: 'list_org_members',
      description:
        'List members of an organization via the Management API. Uses the active organization when organizationId is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          organizationId: {
            type: 'string',
            description: 'Organization id. Defaults to active organization.',
          },
          limit: { type: 'number', description: 'Page size (max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const orgId = resolveOrgId(me, input)
        if (!orgId)
          return jsonResult({
            error: 'organizationId is required when no active organization is set',
          })

        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const cursor = readStringProperty(input, 'cursor')
        const query = new URLSearchParams({ limit: String(limit) })
        if (cursor) query.set('cursor', cursor)
        return apiGet(api, `/v1/organizations/${orgId}/members?${query.toString()}`)
      },
    },
    {
      name: 'list_org_invitations',
      description:
        'List pending organization invitations. Uses the active organization when organizationId is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          organizationId: {
            type: 'string',
            description: 'Organization id. Defaults to active organization.',
          },
          limit: { type: 'number', description: 'Page size (max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const orgId = resolveOrgId(me, input)
        if (!orgId)
          return jsonResult({
            error: 'organizationId is required when no active organization is set',
          })

        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const cursor = readStringProperty(input, 'cursor')
        const query = new URLSearchParams({ limit: String(limit) })
        if (cursor) query.set('cursor', cursor)
        return apiGet(api, `/v1/organizations/${orgId}/invitations?${query.toString()}`)
      },
    },
    {
      name: 'invite_org_member',
      description:
        'Invite a user to the active or specified organization by email and role. Requires organization admin permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Invitee email address.' },
          role: {
            type: 'string',
            description: 'Organization role key, for example admin or member.',
          },
          organizationId: {
            type: 'string',
            description: 'Organization id. Defaults to active organization.',
          },
        },
        required: ['email', 'role'],
      },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const orgId = resolveOrgId(me, input)
        const email = readStringProperty(input, 'email')
        const role = readStringProperty(input, 'role')
        if (!orgId)
          return jsonResult({
            error: 'organizationId is required when no active organization is set',
          })
        if (!email || !role) return jsonResult({ error: 'email and role are required' })

        const result = await api.post(`/v1/organizations/${orgId}/invitations`, { email, role })
        if (!result.ok)
          return jsonResult({ error: result.error.code, httpStatus: result.error.httpStatus })
        return jsonResult(result.value)
      },
    },
    {
      name: 'list_oauth_applications',
      description: 'List OAuth/OIDC applications for the active organization context.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Page size (max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const cursor = readStringProperty(input, 'cursor')
        const query = new URLSearchParams({ limit: String(limit) })
        if (cursor) query.set('cursor', cursor)
        return apiGet(api, `/v1/applications?${query.toString()}`)
      },
    },
    {
      name: 'list_webhook_endpoints',
      description:
        'List webhook endpoints for the active organization context. Secrets are never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Page size (max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const cursor = readStringProperty(input, 'cursor')
        const query = new URLSearchParams({ limit: String(limit) })
        if (cursor) query.set('cursor', cursor)
        return apiGet(api, `/v1/webhooks?${query.toString()}`)
      },
    },
    {
      name: 'list_api_keys',
      description:
        'List Management API keys for the active organization context. Key material and secrets are never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Page size (max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const cursor = readStringProperty(input, 'cursor')
        const query = new URLSearchParams({ limit: String(limit) })
        if (cursor) query.set('cursor', cursor)
        return apiGet(api, `/@xid-kit/web-ui/api-keys?${query.toString()}`)
      },
    },
    {
      name: 'list_org_audit_events',
      description:
        'List audit events for an organization. Uses the active organization when organizationId is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          organizationId: {
            type: 'string',
            description: 'Organization id. Defaults to active organization.',
          },
          limit: { type: 'number', description: 'Page size (max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const orgId = resolveOrgId(me, input)
        if (!orgId)
          return jsonResult({
            error: 'organizationId is required when no active organization is set',
          })

        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const cursor = readStringProperty(input, 'cursor')
        const query = new URLSearchParams({ limit: String(limit) })
        if (cursor) query.set('cursor', cursor)
        return apiGet(api, `/v1/organizations/${orgId}/audit-events?${query.toString()}`)
      },
    },
    {
      name: 'list_platform_organizations',
      description: 'List organizations across the instance. Requires instance manager permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional search query.' },
          limit: { type: 'number', description: 'Page size (max 100).' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        if (!me.user?.instanceManager) {
          return jsonResult({ error: 'instance_manager_required' })
        }

        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const cursor = readStringProperty(input, 'cursor')
        const search = readStringProperty(input, 'query')
        const query = new URLSearchParams({ limit: String(limit) })
        if (cursor) query.set('cursor', cursor)
        if (search) query.set('query', search)
        return apiGet(api, `/v1/platform/organizations?${query.toString()}`)
      },
    },
    {
      name: 'list_platform_users',
      description: 'Search users across the instance. Requires instance manager permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search by email or name fragment.' },
          limit: { type: 'number', description: 'Page size (max 100).' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        if (!me.user?.instanceManager) {
          return jsonResult({ error: 'instance_manager_required' })
        }

        const search = readStringProperty(input, 'query')
        if (!search) return jsonResult({ error: 'query is required' })

        const limit = typeof input.limit === 'number' ? Math.min(input.limit, 100) : 20
        const query = new URLSearchParams({ query: search, limit: String(limit) })
        return apiGet(api, `/v1/platform/users?${query.toString()}`)
      },
    },
  ]
}
