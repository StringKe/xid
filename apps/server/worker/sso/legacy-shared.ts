// Shared runtime for enterprise legacy SSO protocols (LDAP, WS-Fed, SWA, header-based).
// Connection config lives in sso_connections.attributeMapping._legacy with per-protocol fields.
// All D1 access uses createTenantDb; tenant_id comes from TenantContext, never request body.

import { createTenantDb, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession } from '../lib/session'
import { SSO_AUTH_CONTEXT } from '../lib/auth-context'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import type { XidHonoEnv } from '../lib/types'
import { jitProvision } from './jit'
import type { SsoAssertion } from './jit'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'
import { resolveSsoConnectionTenant, withTenant } from './tenant'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { type LegacyConfig, readLegacyConfigFromMapping } from './legacy-config'
import type { LegacyProtocol } from './legacy-protocols'

export {
  assertInboundSsoProtocol,
  INBOUND_SSO_PROTOCOLS,
  isInboundSsoProtocol,
  isLegacySsoProtocol,
  LEGACY_SSO_PROTOCOLS,
  type InboundSsoProtocol,
  type LegacyProtocol,
} from './legacy-protocols'
export { readLegacyConfigFromMapping, type LegacyConfig } from './legacy-config'
export {
  assertHeaderConnectionConfig,
  constantTimeEqual,
  digestTrustedProxySecret,
  trustedProxySecretConfigured,
  verifyTrustedProxySecret,
} from './header-proxy-secret'
export { prepareLegacyAttributeMapping } from './legacy-mapping'

export type LegacyConnection = typeof schema.ssoConnections.$inferSelect

export type LegacyProfile = {
  idpId: string
  email: string | null
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  groups: string[]
  customAttributes: Record<string, unknown>
}

export function legacyConfig(connection: LegacyConnection): LegacyConfig {
  return readLegacyConfigFromMapping(connection.attributeMapping)
}

export async function resolveLegacyConnection(
  c: Context<XidHonoEnv>,
  connectionId: string,
  protocol: LegacyProtocol,
): Promise<LegacyConnection> {
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    const db = createTenantDb(c.env.DB, tenant)
    const row = await db.ssoConnections.findOne(eq(schema.ssoConnections.id, connectionId))
    if (!row || row.protocol !== protocol || row.status !== 'active') {
      throw new AppError('connection_not_found', { httpStatus: 404 })
    }
    if (
      (protocol === 'wsfed' && !row.idpSsoUrl) ||
      (row.idpSsoUrl !== null &&
        row.idpSsoUrl !== undefined &&
        !isPublicHttpsUrl(row.idpSsoUrl) &&
        !(isDevOrTestEnvironment(c.env) && isLoopbackHttpUrl(row.idpSsoUrl)))
    ) {
      throw new AppError('connection_not_found', { httpStatus: 404 })
    }
    return row
  })
}

export function profileToAssertion(
  profile: LegacyProfile,
  connection: LegacyConnection,
): SsoAssertion {
  return {
    idpId: profile.idpId,
    connectionId: connection.id,
    orgId: connection.orgId,
    email: profile.email,
    emailVerified: profile.emailVerified,
    firstName: profile.firstName,
    lastName: profile.lastName,
    groups: profile.groups,
    customAttributes: profile.customAttributes,
  }
}

function isLocalPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

export async function completeLegacyLogin(input: {
  c: Context<XidHonoEnv>
  connection: LegacyConnection
  profile: LegacyProfile
  redirectAfterLogin?: string
  returnToOrigin?: string
  skipDefaultMembership?: boolean
}): Promise<Response> {
  const { c, connection, profile } = input
  const config = legacyConfig(connection)
  const email = profile.email
  await enforceEnterpriseSsoPolicy({ c, action: 'login', email })

  const assertion = profileToAssertion(profile, connection)
  const skipDefaultMembership = input.skipDefaultMembership ?? false
  const { userId } = await jitProvision(c, assertion, { skipDefaultMembership })

  const now = new Date()
  const defaultLandingPath = defaultLandingPathFor(c.get('tenant'))
  const safeLocalRedirect = isLocalPath(input.redirectAfterLogin ?? config.redirectAfterLogin ?? '')
    ? (input.redirectAfterLogin ?? config.redirectAfterLogin ?? defaultLandingPath)
    : defaultLandingPath
  const returnToOrigin = input.returnToOrigin ?? c.get('tenant').issuer.replace(/\/$/, '')
  const mfaGate = await resolvePostAuthMfaGate(c, c.get('tenant'), {
    userId,
    returnPath: safeLocalRedirect,
    sessionAmr: SSO_AUTH_CONTEXT.amr,
  })
  await issueSession(c, {
    sessionId: createPersistedId('session'),
    userId,
    activeOrgId: skipDefaultMembership ? null : connection.orgId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: SSO_AUTH_CONTEXT,
    authenticatedAt: now,
    rememberMe: true,
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  })
  const safeRedirect = `${returnToOrigin}${mfaGate.redirectUrl ?? safeLocalRedirect}`
  return c.redirect(safeRedirect, 302)
}
