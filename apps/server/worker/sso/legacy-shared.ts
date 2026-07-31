// Shared helpers for enterprise legacy SSO protocols (LDAP, WS-Fed, SWA, header-based).
// Connection config lives in sso_connections.attributeMapping._legacy with per-protocol fields.
// All D1 access uses createTenantDb; tenant_id comes from TenantContext, never request body.

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
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
import { isLoopbackHttpUrl, isPublicHttpsUrl, publicHttpsUrlSchema } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'

export type LegacyProtocol = 'ldap' | 'wsfed' | 'swa' | 'header'

export const LEGACY_SSO_PROTOCOLS = ['ldap', 'wsfed', 'swa', 'header'] as const

export const INBOUND_SSO_PROTOCOLS = ['saml', 'oidc', ...LEGACY_SSO_PROTOCOLS] as const

export type InboundSsoProtocol = (typeof INBOUND_SSO_PROTOCOLS)[number]

const TRUSTED_PROXY_DIGEST_PREFIX = 'sha256:v1:'

export function isInboundSsoProtocol(value: string): value is InboundSsoProtocol {
  return (INBOUND_SSO_PROTOCOLS as readonly string[]).includes(value)
}

export function assertInboundSsoProtocol(protocol: string): InboundSsoProtocol {
  if (!isInboundSsoProtocol(protocol)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'protocol' },
      longMessage: 'unsupported_sso_protocol',
    })
  }
  return protocol
}

export function readLegacyConfigFromMapping(
  attributeMapping: Record<string, unknown> | null | undefined,
): LegacyConfig {
  const legacy =
    attributeMapping &&
    typeof attributeMapping === 'object' &&
    attributeMapping['_legacy'] &&
    typeof attributeMapping['_legacy'] === 'object'
      ? (attributeMapping['_legacy'] as Record<string, unknown>)
      : {}
  return {
    redirectAfterLogin:
      typeof legacy['redirectAfterLogin'] === 'string' ? legacy['redirectAfterLogin'] : undefined,
    trustedProxySecret:
      typeof legacy['trustedProxySecret'] === 'string' ? legacy['trustedProxySecret'] : undefined,
    trustedProxySecretDigest:
      typeof legacy['trustedProxySecretDigest'] === 'string'
        ? legacy['trustedProxySecretDigest']
        : undefined,
    headerEmail:
      typeof legacy['headerEmail'] === 'string' ? legacy['headerEmail'] : 'X-Remote-Email',
    headerUser: typeof legacy['headerUser'] === 'string' ? legacy['headerUser'] : 'X-Remote-User',
    headerGroups:
      typeof legacy['headerGroups'] === 'string' ? legacy['headerGroups'] : 'X-Remote-Groups',
    ldapGatewayUrl:
      typeof legacy['ldapGatewayUrl'] === 'string' ? legacy['ldapGatewayUrl'] : undefined,
    bindDnTemplate:
      typeof legacy['bindDnTemplate'] === 'string' ? legacy['bindDnTemplate'] : undefined,
    wsfedRealm: typeof legacy['wsfedRealm'] === 'string' ? legacy['wsfedRealm'] : undefined,
    wsfedReplyUrl:
      typeof legacy['wsfedReplyUrl'] === 'string' ? legacy['wsfedReplyUrl'] : undefined,
    wsfedAllowIdpInitiated:
      typeof legacy['wsfedAllowIdpInitiated'] === 'boolean'
        ? legacy['wsfedAllowIdpInitiated']
        : false,
    swaTargetUrl: typeof legacy['swaTargetUrl'] === 'string' ? legacy['swaTargetUrl'] : undefined,
    vaultCredentialRef:
      typeof legacy['vaultCredentialRef'] === 'string' ? legacy['vaultCredentialRef'] : undefined,
  }
}

export function assertHeaderConnectionConfig(
  protocol: string,
  attributeMapping: Record<string, unknown> | null | undefined,
): void {
  if (protocol !== 'header') return
  const config = readLegacyConfigFromMapping(attributeMapping)
  if (
    !config.trustedProxySecret?.trim() &&
    !isTrustedProxyDigest(config.trustedProxySecretDigest)
  ) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'attribute_mapping._legacy.trustedProxySecret' },
      longMessage: 'header_trusted_proxy_secret_required',
    })
  }
}

function legacyObject(
  mapping: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const value = mapping?.['_legacy']
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function isTrustedProxyDigest(value: string | undefined): boolean {
  return Boolean(
    value?.startsWith(TRUSTED_PROXY_DIGEST_PREFIX) &&
    /^[0-9a-f]{64}$/.test(value.slice(TRUSTED_PROXY_DIGEST_PREFIX.length)),
  )
}

export function trustedProxySecretConfigured(
  attributeMapping: Record<string, unknown> | null | undefined,
): boolean {
  const config = readLegacyConfigFromMapping(attributeMapping)
  return (
    Boolean(config.trustedProxySecret?.trim()) ||
    isTrustedProxyDigest(config.trustedProxySecretDigest)
  )
}

export async function digestTrustedProxySecret(secret: string): Promise<string> {
  return `${TRUSTED_PROXY_DIGEST_PREFIX}${await sha256Hex(secret)}`
}

export async function verifyTrustedProxySecret(
  presented: string,
  config: LegacyConfig,
): Promise<{ valid: boolean; migrationDigest?: string }> {
  if (!presented) return { valid: false }
  const presentedHash = await sha256Hex(presented)
  if (isTrustedProxyDigest(config.trustedProxySecretDigest)) {
    const expected = config.trustedProxySecretDigest!.slice(TRUSTED_PROXY_DIGEST_PREFIX.length)
    return { valid: constantTimeEqual(presentedHash, expected) }
  }
  if (!config.trustedProxySecret?.trim()) return { valid: false }
  const legacyHash = await sha256Hex(config.trustedProxySecret)
  const valid = constantTimeEqual(presentedHash, legacyHash)
  return valid
    ? { valid: true, migrationDigest: `${TRUSTED_PROXY_DIGEST_PREFIX}${legacyHash}` }
    : { valid: false }
}

export async function prepareLegacyAttributeMapping(
  protocol: string,
  attributeMapping: Record<string, unknown>,
  previousMapping?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const prepared: Record<string, unknown> = { ...attributeMapping }
  const legacy = legacyObject(attributeMapping)
  const previousLegacy = legacyObject(previousMapping)

  if (protocol === 'header') {
    const plaintext =
      typeof legacy['trustedProxySecret'] === 'string' ? legacy['trustedProxySecret'] : undefined
    delete legacy['trustedProxySecret']
    delete legacy['trustedProxySecretDigest']
    if (plaintext !== undefined) {
      if (!plaintext.trim()) {
        throw new AppError('validation_failed', {
          httpStatus: 422,
          meta: { paramName: 'attribute_mapping._legacy.trustedProxySecret' },
        })
      }
      legacy['trustedProxySecretDigest'] = await digestTrustedProxySecret(plaintext)
    } else if (
      isTrustedProxyDigest(previousLegacy['trustedProxySecretDigest'] as string | undefined)
    ) {
      legacy['trustedProxySecretDigest'] = previousLegacy['trustedProxySecretDigest']
    } else if (typeof previousLegacy['trustedProxySecret'] === 'string') {
      legacy['trustedProxySecretDigest'] = await digestTrustedProxySecret(
        previousLegacy['trustedProxySecret'],
      )
    }
  }

  if (protocol === 'ldap' && typeof legacy['ldapGatewayUrl'] === 'string') {
    if (!v.safeParse(publicHttpsUrlSchema, legacy['ldapGatewayUrl']).success) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'attribute_mapping._legacy.ldapGatewayUrl' },
      })
    }
  }

  if (protocol === 'wsfed') {
    if (
      typeof legacy['wsfedRealm'] !== 'string' ||
      !legacy['wsfedRealm'].trim() ||
      typeof legacy['wsfedReplyUrl'] !== 'string' ||
      !v.safeParse(publicHttpsUrlSchema, legacy['wsfedReplyUrl']).success
    ) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'attribute_mapping._legacy' },
      })
    }
    if (
      legacy['wsfedAllowIdpInitiated'] !== undefined &&
      typeof legacy['wsfedAllowIdpInitiated'] !== 'boolean'
    ) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'attribute_mapping._legacy.wsfedAllowIdpInitiated' },
      })
    }
  }

  prepared['_legacy'] = legacy
  for (const key of ['_swaVault', '_swaVaultEnvelope'] as const) {
    if (!(key in prepared) && previousMapping?.[key] !== undefined) {
      prepared[key] = previousMapping[key]
    }
  }
  assertHeaderConnectionConfig(protocol, prepared)
  return prepared
}

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

export type LegacyConfig = {
  redirectAfterLogin?: string
  trustedProxySecret?: string
  trustedProxySecretDigest?: string
  headerEmail?: string
  headerUser?: string
  headerGroups?: string
  ldapGatewayUrl?: string
  bindDnTemplate?: string
  wsfedRealm?: string
  wsfedReplyUrl?: string
  wsfedAllowIdpInitiated?: boolean
  swaTargetUrl?: string
  vaultCredentialRef?: string
}

const DEFAULT_AUTH_RETURN_PATH = '/console'

function readLegacyConfig(connection: LegacyConnection): LegacyConfig {
  const mapping = connection.attributeMapping
  const legacy =
    mapping &&
    typeof mapping === 'object' &&
    mapping['_legacy'] &&
    typeof mapping['_legacy'] === 'object'
      ? (mapping['_legacy'] as Record<string, unknown>)
      : {}
  return {
    redirectAfterLogin:
      typeof legacy['redirectAfterLogin'] === 'string' ? legacy['redirectAfterLogin'] : undefined,
    trustedProxySecret:
      typeof legacy['trustedProxySecret'] === 'string' ? legacy['trustedProxySecret'] : undefined,
    trustedProxySecretDigest:
      typeof legacy['trustedProxySecretDigest'] === 'string'
        ? legacy['trustedProxySecretDigest']
        : undefined,
    headerEmail:
      typeof legacy['headerEmail'] === 'string' ? legacy['headerEmail'] : 'X-Remote-Email',
    headerUser: typeof legacy['headerUser'] === 'string' ? legacy['headerUser'] : 'X-Remote-User',
    headerGroups:
      typeof legacy['headerGroups'] === 'string' ? legacy['headerGroups'] : 'X-Remote-Groups',
    ldapGatewayUrl:
      typeof legacy['ldapGatewayUrl'] === 'string' ? legacy['ldapGatewayUrl'] : undefined,
    bindDnTemplate:
      typeof legacy['bindDnTemplate'] === 'string' ? legacy['bindDnTemplate'] : undefined,
    wsfedRealm: typeof legacy['wsfedRealm'] === 'string' ? legacy['wsfedRealm'] : undefined,
    wsfedReplyUrl:
      typeof legacy['wsfedReplyUrl'] === 'string' ? legacy['wsfedReplyUrl'] : undefined,
    wsfedAllowIdpInitiated:
      typeof legacy['wsfedAllowIdpInitiated'] === 'boolean'
        ? legacy['wsfedAllowIdpInitiated']
        : false,
    swaTargetUrl: typeof legacy['swaTargetUrl'] === 'string' ? legacy['swaTargetUrl'] : undefined,
    vaultCredentialRef:
      typeof legacy['vaultCredentialRef'] === 'string' ? legacy['vaultCredentialRef'] : undefined,
  }
}

export function legacyConfig(connection: LegacyConnection): LegacyConfig {
  return readLegacyConfig(connection)
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
  const config = readLegacyConfig(connection)
  const email = profile.email
  await enforceEnterpriseSsoPolicy({ c, action: 'login', email })

  const assertion = profileToAssertion(profile, connection)
  const skipDefaultMembership = input.skipDefaultMembership ?? false
  const { userId } = await jitProvision(c, assertion, { skipDefaultMembership })

  const now = new Date()
  const safeLocalRedirect = isLocalPath(input.redirectAfterLogin ?? config.redirectAfterLogin ?? '')
    ? (input.redirectAfterLogin ?? config.redirectAfterLogin ?? DEFAULT_AUTH_RETURN_PATH)
    : DEFAULT_AUTH_RETURN_PATH
  const returnToOrigin = input.returnToOrigin ?? c.get('tenant').issuer.replace(/\/$/, '')
  const mfaGate = await resolvePostAuthMfaGate(c, c.get('tenant'), {
    userId,
    returnPath: safeLocalRedirect,
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

export function constantTimeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length
  const maxLength = Math.max(a.length, b.length)
  for (let i = 0; i < maxLength; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return mismatch === 0
}
