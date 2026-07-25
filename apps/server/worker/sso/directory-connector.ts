// Directory connector framework and header-based SSO (enterprise legacy protocols).
// Connector registry covers non-SCIM provisioning transports; only header SSO and connector
// validation are locally implemented. LDAP/SQL/REST/SOAP/PowerShell connectors remain stubs.

import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { firstIssuePath, readJsonBody } from '../lib/validate'
import {
  completeLegacyLogin,
  constantTimeEqual,
  legacyConfig,
  resolveLegacyConnection,
  type LegacyProfile,
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
    description: 'Trusted reverse-proxy headers mapped to XID users with optional shared secret.',
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

function assertTrustedProxy(c: Context<XidHonoEnv>, secret: string | undefined): void {
  if (!secret?.trim()) {
    throw new AppError('invalid_credentials', { longMessage: 'trusted_proxy_secret_required' })
  }
  const presented =
    c.req.header('X-Trusted-Proxy-Secret') ?? c.req.header('X-Forwarded-Auth-Secret') ?? ''
  if (!presented || !constantTimeEqual(presented, secret)) {
    throw new AppError('invalid_credentials', { longMessage: 'trusted_proxy_secret_invalid' })
  }
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
    const config = legacyConfig(connection)
    return c.json(
      {
        valid: true,
        connector: connector.key,
        tenantId: tenant.tenantId,
        connectionId: connection.id,
        hasTrustedProxySecret: Boolean(config.trustedProxySecret),
        hasLdapGateway: Boolean(config.ldapGatewayUrl),
      },
      200,
    )
  })
}

async function handleHeaderAuthenticate(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const connection = await resolveLegacyConnection(c, connectionId, 'header')
    const config = legacyConfig(connection)
    assertTrustedProxy(c, config.trustedProxySecret)
    const profile = profileFromHeaders(c, config)
    if (!profile)
      throw new AppError('invalid_credentials', { longMessage: 'header_identity_missing' })
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
