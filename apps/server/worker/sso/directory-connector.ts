// Directory connector framework and header-based SSO (enterprise legacy protocols).
// Connector registry covers non-SCIM provisioning transports; only header SSO and connector
// validation are locally implemented. LDAP/SQL/REST/SOAP/PowerShell connectors remain stubs.

import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError, isAppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { firstIssuePath, readJsonBody } from '../lib/validate'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { requestIp } from '../me-auth/shared'
import { requireApiKeyOrOrgManager } from '../v1/shared'
import { ldapGatewaySecretConfigured } from './ldap-gateway-secret'
import { isUsableLegacyTargetUrl } from './legacy-target-url'
import {
  completeLegacyLogin,
  legacyConfig,
  resolveLegacyConnection,
  trustedProxySecretConfigured,
  type LegacyProfile,
  verifyTrustedProxySecret,
} from './legacy-shared'
import { resolveSsoConnectionTenant, withTenant } from './tenant'

export type DirectoryConnectorType = {
  key: string
  displayName: string
  transport: 'header' | 'ldap' | 'sql' | 'rest' | 'soap' | 'powershell' | 'ecma'
  support: 'implemented' | 'stub'
  description: string
}

export const DIRECTORY_CONNECTOR_TYPES: DirectoryConnectorType[] = [
  {
    key: 'header_sso',
    displayName: 'Header-based SSO',
    transport: 'header',
    support: 'implemented',
    description: 'Trusted reverse-proxy headers mapped to XID users with a required shared secret.',
  },
  {
    key: 'ldap_bind',
    displayName: 'LDAP direct bind',
    transport: 'ldap',
    support: 'implemented',
    description:
      'HTTP LDAP gateway bind for upstream authentication; native LDAP sockets are not used in Workers.',
  },
  {
    key: 'entra_ldap',
    displayName: 'Microsoft Entra LDAP connector',
    transport: 'ldap',
    support: 'stub',
    description: 'Non-SCIM LDAP provisioning connector; use inbound SCIM Service Provider instead.',
  },
  {
    key: 'sql',
    displayName: 'SQL connector',
    transport: 'sql',
    support: 'stub',
    description: 'SQL-based provisioning connector stub; not enabled for production.',
  },
  {
    key: 'rest',
    displayName: 'REST connector',
    transport: 'rest',
    support: 'stub',
    description: 'REST-based provisioning connector stub; not enabled for production.',
  },
  {
    key: 'soap',
    displayName: 'SOAP connector',
    transport: 'soap',
    support: 'stub',
    description: 'SOAP-based provisioning connector stub; not enabled for production.',
  },
  {
    key: 'powershell',
    displayName: 'PowerShell connector',
    transport: 'powershell',
    support: 'stub',
    description: 'PowerShell-based provisioning connector stub; not enabled for production.',
  },
  {
    key: 'ecma',
    displayName: 'ECMA connector',
    transport: 'ecma',
    support: 'stub',
    description: 'ECMA-based provisioning connector stub; not enabled for production.',
  },
]

function parseHeaderGroups(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function profileFromHeaders(
  c: Context<XidHonoEnv>,
  config: ReturnType<typeof legacyConfig>,
): LegacyProfile | null {
  const remoteUser = c.req.header(config.headerUser ?? 'X-Remote-User')?.trim() ?? ''
  const remoteEmail = c.req.header(config.headerEmail ?? 'X-Remote-Email')?.trim() ?? ''
  const remoteGroups = c.req.header(config.headerGroups ?? 'X-Remote-Groups') ?? null
  if (!remoteUser && !remoteEmail) return null
  const idpId = remoteUser || remoteEmail
  return {
    idpId,
    email: remoteEmail || (remoteUser.includes('@') ? remoteUser : null),
    emailVerified: remoteEmail.length > 0 || remoteUser.includes('@'),
    firstName: c.req.header('X-Remote-Given-Name') ?? null,
    lastName: c.req.header('X-Remote-Family-Name') ?? null,
    groups: parseHeaderGroups(remoteGroups),
    customAttributes: { protocol: 'header_sso' },
  }
}

async function assertTrustedProxy(
  c: Context<XidHonoEnv>,
  connection: Awaited<ReturnType<typeof resolveLegacyConnection>>,
): Promise<void> {
  const config = legacyConfig(connection)
  const presented =
    c.req.header('X-Trusted-Proxy-Secret') ?? c.req.header('X-Forwarded-Auth-Secret') ?? ''
  const verified = await verifyTrustedProxySecret(presented, config)
  if (!verified.valid) {
    throw new AppError('invalid_credentials', { longMessage: 'trusted_proxy_secret_invalid' })
  }
  if (!verified.migrationDigest) return

  const mapping = { ...(connection.attributeMapping ?? {}) }
  const currentLegacy =
    mapping['_legacy'] && typeof mapping['_legacy'] === 'object'
      ? { ...(mapping['_legacy'] as Record<string, unknown>) }
      : {}
  delete currentLegacy['trustedProxySecret']
  currentLegacy['trustedProxySecretDigest'] = verified.migrationDigest
  mapping['_legacy'] = currentLegacy
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await db.ssoConnections.update(
    { attributeMapping: mapping },
    eq(schema.ssoConnections.id, connection.id),
  )
}

async function handleConnectorTypes(c: Context<XidHonoEnv>): Promise<Response> {
  return c.json({ connectors: DIRECTORY_CONNECTOR_TYPES }, 200)
}

// validate body:connectorKey 可选 string。坏 JSON 按 {} 处理(回落默认 connector)。
const connectorValidateBodySchema = v.object({ connectorKey: v.optional(v.string()) })

async function handleConnectorValidate(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  const json = await readJsonBody(c)
  const parsed = json.ok ? v.safeParse(connectorValidateBodySchema, json.value) : null
  if (parsed && !parsed.success) {
    throw new AppError('invalid_request', {
      meta: { paramName: firstIssuePath(parsed.issues) },
    })
  }
  const connectorKey = parsed?.success ? (parsed.output.connectorKey ?? 'header_sso') : 'header_sso'
  const connector = DIRECTORY_CONNECTOR_TYPES.find((item) => item.key === connectorKey)
  if (!connector) throw new AppError('invalid_request', { longMessage: 'connector_unknown' })
  if (connector.support !== 'implemented') {
    return c.json(
      { valid: false, connector: connector.key, reason: 'connector_not_implemented' },
      200,
    )
  }

  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const protocol = connector.transport === 'ldap' ? 'ldap' : 'header'
    const connection = await resolveLegacyConnection(c, connectionId, protocol)
    await requireApiKeyOrOrgManager(c, connection.orgId, 'connections:read')
    const config = legacyConfig(connection)
    return c.json(
      {
        valid: true,
        connector: connector.key,
        tenantId: tenant.tenantId,
        connectionId: connection.id,
        hasTrustedProxySecret: trustedProxySecretConfigured(connection.attributeMapping),
        hasLdapGateway:
          isUsableLegacyTargetUrl(config.ldapGatewayUrl) &&
          ldapGatewaySecretConfigured(connection.attributeMapping),
      },
      200,
    )
  })
}

const HEADER_AUTH_OPAQUE_CODES: ReadonlySet<string> = new Set([
  'connection_not_found',
  'invalid_credentials',
])

// Every failure before a verified identity is the same 401, so the endpoint does not reveal
// whether a connection id exists or which check failed.
async function asHeaderAuthFailure<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    if (isAppError(cause) && HEADER_AUTH_OPAQUE_CODES.has(cause.code)) {
      throw new AppError('invalid_credentials', { cause })
    }
    throw cause
  }
}

async function handleHeaderAuthenticate(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_credentials')

  const tenant = await asHeaderAuthFailure(() => resolveSsoConnectionTenant(c, connectionId))
  return withTenant(c, tenant, async () => {
    // Keyed by connection and source IP and reset on success: a busy reverse proxy keeps
    // logging users in, while secret guessing from any address is throttled with backoff.
    const account = `${connectionId}:${requestIp(c) ?? 'unknown'}`
    await enforceVerifyRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'sso_header',
      account,
      ip: null,
    })
    const { connection, profile } = await asHeaderAuthFailure(async () => {
      const resolved = await resolveLegacyConnection(c, connectionId, 'header')
      await assertTrustedProxy(c, resolved)
      const identity = profileFromHeaders(c, legacyConfig(resolved))
      if (!identity) throw new AppError('invalid_credentials')
      return { connection: resolved, profile: identity }
    })
    await resetVerifyAccountRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'sso_header',
      account,
    })
    return completeLegacyLogin({
      c,
      connection,
      profile,
      returnToOrigin: tenant.issuer.replace(/\/$/, ''),
    })
  })
}

const directoryConnectors = new Hono<XidHonoEnv>()
directoryConnectors.get('/types', handleConnectorTypes)
directoryConnectors.post('/:connectionId/validate', handleConnectorValidate)

const headerSso = new Hono<XidHonoEnv>()
headerSso.post('/:connectionId/authenticate', handleHeaderAuthenticate)

export function registerDirectoryConnectorRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/directory-connectors', directoryConnectors)
  app.route('/sso/header', headerSso)
}
