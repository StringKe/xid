// SWA (Secure Web Authentication) password vaulting for downstream applications that only offer a
// username/password form. A signed-in member stores their own downstream credentials, and the
// launch endpoint replays them by auto-submitting the form at the connection's swaTargetUrl.
// SWA never authenticates the member to XID itself.

import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { readSessionForTenant } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { findActiveMembership } from '../me/shared'
import { legacyConfig, resolveLegacyConnection, type LegacyConnection } from './legacy-shared'
import { isUsableLegacyTargetUrl } from './legacy-target-url'
import { swaLaunchResponse } from './swa-launch-page'
import { readSwaCredential, saveSwaCredential } from './swa-vault'
import { resolveSsoConnectionTenant, withTenant } from './tenant'

const vaultBodySchema = v.object({
  username: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
})

type SwaMemberContext = {
  connection: LegacyConnection
  session: SessionData
}

// Resolves the connection tenant, then requires a non-impersonated XID session in that tenant whose
// user is an active member of the connection's organization.
async function withSwaMember(
  c: Context<XidHonoEnv>,
  handler: (member: SwaMemberContext) => Promise<Response>,
): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('connection_not_found', { httpStatus: 404 })
  const tenant = await resolveSsoConnectionTenant(c, connectionId)
  const session = await readSessionForTenant(c, tenant)
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  if (session.isImpersonation) throw new AppError('forbidden', { httpStatus: 403 })
  return withTenant(c, tenant, async () => {
    const connection = await resolveLegacyConnection(c, connectionId, 'swa')
    const membership = await findActiveMembership(c, session.userId, connection.orgId)
    if (!membership) throw new AppError('connection_not_found', { httpStatus: 404 })
    return handler({ connection, session })
  })
}

async function handleVaultRead(c: Context<XidHonoEnv>): Promise<Response> {
  return withSwaMember(c, async ({ connection, session }) => {
    const credential = await readSwaCredential(c.env, connection, session.userId)
    return c.json({ stored: credential !== null, username: credential?.username ?? null }, 200, {
      'Cache-Control': 'no-store',
    })
  })
}

async function handleVaultWrite(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(vaultBodySchema, json.value)
  return withSwaMember(c, async ({ connection, session }) => {
    await saveSwaCredential({
      env: c.env,
      tenant: c.get('tenant'),
      connectionId: connection.id,
      userId: session.userId,
      credential: { username: body.username, password: body.password },
    })
    return c.json({ stored: true, username: body.username }, 200, {
      'Cache-Control': 'no-store',
    })
  })
}

async function handleVaultDelete(c: Context<XidHonoEnv>): Promise<Response> {
  return withSwaMember(c, async ({ connection, session }) => {
    await saveSwaCredential({
      env: c.env,
      tenant: c.get('tenant'),
      connectionId: connection.id,
      userId: session.userId,
      credential: null,
    })
    return c.body(null, 204)
  })
}

async function handleLaunch(c: Context<XidHonoEnv>): Promise<Response> {
  return withSwaMember(c, async ({ connection, session }) => {
    const config = legacyConfig(connection)
    if (!isUsableLegacyTargetUrl(config.swaTargetUrl)) {
      throw new AppError('connection_not_found', { httpStatus: 404 })
    }
    const credential = await readSwaCredential(c.env, connection, session.userId)
    if (!credential) throw new AppError('not_found', { longMessage: 'swa_credential_not_stored' })
    return swaLaunchResponse({
      targetUrl: config.swaTargetUrl,
      usernameField: config.swaUsernameField,
      passwordField: config.swaPasswordField,
      credential,
    })
  })
}

const swa = new Hono<XidHonoEnv>()
swa.get('/:connectionId/vault', handleVaultRead)
swa.post('/:connectionId/vault', handleVaultWrite)
swa.delete('/:connectionId/vault', handleVaultDelete)
swa.get('/:connectionId/launch', handleLaunch)

export function registerSwaRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/swa', swa)
}
