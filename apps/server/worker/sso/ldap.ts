// LDAP direct bind upstream authentication (enterprise legacy protocol).
// Workers cannot open native LDAP sockets; production bind uses an HTTP LDAP gateway URL
// configured per connection. Local L3 uses the fake LDAP harness in development/test only.

import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody } from '../lib/validate'
import { enforceVerifyRateLimit, resetVerifyAccountRateLimit } from '../lib/verify-rate-limit'
import { requestIp, verifyTurnstile } from '../me-auth/shared'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { fakeLdapBind } from '../test-harness/fake-ldap'
import { readBoundedJson } from './bounded-json'
import {
  completeLegacyLogin,
  legacyConfig,
  resolveLegacyConnection,
  type LegacyProfile,
} from './legacy-shared'
import { resolveSsoConnectionTenant, withTenant } from './tenant'

// LDAP 登录 body。形状失败统一按 credentials_required 处理(凭证类端点不区分"形状错误"与
// "凭证缺失",见 anti-abuse rule),不走 validation_failed 422。
const ldapLoginBodySchema = v.object({
  username: v.optional(v.string()),
  password: v.optional(v.string()),
  redirectAfterLogin: v.optional(v.string()),
  turnstileToken: v.optional(v.nullable(v.string())),
})

const ldapGatewayProfileSchema = v.object({
  idpId: v.pipe(v.string(), v.minLength(1)),
  email: v.nullable(v.string()),
  emailVerified: v.boolean(),
  firstName: v.nullable(v.string()),
  lastName: v.nullable(v.string()),
  groups: v.array(v.string()),
  customAttributes: v.record(v.string(), v.unknown()),
})

const LDAP_GATEWAY_TIMEOUT_MS = 5_000
const LDAP_GATEWAY_MAX_RESPONSE_BYTES = 64 * 1024

async function gatewayLdapBind(
  gatewaySecret: string,
  gatewayUrl: string,
  username: string,
  password: string,
): Promise<LegacyProfile | null> {
  let res: Response
  try {
    res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gatewaySecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
      redirect: 'manual',
      signal: AbortSignal.timeout(LDAP_GATEWAY_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new AppError('internal_error', { cause, longMessage: 'ldap_gateway_unavailable' })
  }
  if (res.status === 401) return null
  if (!res.ok) throw new AppError('internal_error', { longMessage: 'ldap_gateway_error' })
  let payload: unknown
  try {
    payload = await readBoundedJson(res, LDAP_GATEWAY_MAX_RESPONSE_BYTES)
  } catch (cause) {
    throw new AppError('internal_error', { cause, longMessage: 'ldap_gateway_response_invalid' })
  }
  const parsed = v.safeParse(ldapGatewayProfileSchema, payload)
  if (!parsed.success) {
    throw new AppError('internal_error', { longMessage: 'ldap_gateway_response_invalid' })
  }
  return parsed.output
}

export async function ldapDirectBind(
  c: Context<XidHonoEnv>,
  username: string,
  password: string,
  gatewayUrl?: string,
): Promise<LegacyProfile | null> {
  if (isDevOrTestEnvironment(c.env)) {
    return fakeLdapBind(username, password)
  }
  if (gatewayUrl) {
    if (!v.safeParse(publicHttpsUrlSchema, gatewayUrl).success) {
      throw new AppError('internal_error', { longMessage: 'ldap_gateway_url_invalid' })
    }
    const gatewaySecret = c.env.LDAP_GATEWAY_SHARED_SECRET?.trim()
    if (!gatewaySecret) {
      throw new AppError('internal_error', { longMessage: 'ldap_gateway_secret_not_configured' })
    }
    return gatewayLdapBind(gatewaySecret, gatewayUrl, username, password)
  }
  throw new AppError('internal_error', { longMessage: 'ldap_gateway_not_configured' })
}

async function handleLdapLogin(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  const json = await readJsonBody(c)
  const parsed = json.ok ? v.safeParse(ldapLoginBodySchema, json.value) : null
  const username = parsed?.success ? (parsed.output.username?.trim() ?? '') : ''
  const password = parsed?.success ? (parsed.output.password ?? '') : ''
  if (!username || !password)
    throw new AppError('invalid_request', { longMessage: 'credentials_required' })

  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  return withTenant(c, tenant, async () => {
    await verifyTurnstile(
      parsed?.success ? parsed.output.turnstileToken : null,
      c.env,
      requestIp(c),
    )
    const account = `${connectionId}:${username.toLowerCase()}`
    await enforceVerifyRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'sso_ldap',
      account,
      ip: requestIp(c),
    })
    const connection = await resolveLegacyConnection(c, connectionId, 'ldap')
    const config = legacyConfig(connection)
    const profile = await ldapDirectBind(c, username, password, config.ldapGatewayUrl)
    if (!profile) throw new AppError('invalid_credentials')
    await resetVerifyAccountRateLimit({
      env: c.env,
      tenantId: tenant.tenantId,
      scope: 'sso_ldap',
      account,
    })
    return completeLegacyLogin({
      c,
      connection,
      profile,
      redirectAfterLogin: parsed?.success ? parsed.output.redirectAfterLogin : undefined,
      returnToOrigin: tenant.issuer.replace(/\/$/, ''),
    })
  })
}

const ldap = new Hono<XidHonoEnv>()
ldap.post('/:connectionId/login', handleLdapLogin)

export function registerLdapRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/ldap', ldap)
}
