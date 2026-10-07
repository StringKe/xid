// GET /v1/me/authorized-apps + DELETE /v1/me/authorized-apps/:clientId:用户在同意页授权过的应用。
// 撤销删除 consent 行并撤销该用户在该应用的 access / refresh token,浏览器会话不受影响;
// 下次该应用请求授权时重新显示同意页。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { revokeUserCredentials } from '../lib/revoke-user-credentials'
import { requireStepUp } from '../lib/step-up'
import type { XidHonoEnv } from '../lib/types'
import { resolveClientDisplay } from '../oidc/client-display'
import { readAllById, requireSession } from './shared'

type AuthorizedApp = {
  clientId: string
  name: string
  logoUrl: string | null
  // 第一个 https 回调地址的 origin,让用户认出授权后会被带去哪里。
  redirectOrigin: string | null
  grantedScopes: string[]
  createdAt: string
  updatedAt: string
}

type ApplicationRow = typeof schema.applications.$inferSelect

function redirectOriginOf(application: ApplicationRow | undefined): string | null {
  for (const uri of application?.redirectUris ?? []) {
    if (!URL.canParse(uri)) continue
    const url = new URL(uri)
    if (url.protocol === 'https:') return url.origin
  }
  return null
}

async function toAuthorizedApp(
  c: Context<XidHonoEnv>,
  consent: typeof schema.oauthConsents.$inferSelect,
  application: ApplicationRow | undefined,
): Promise<AuthorizedApp> {
  const display = await resolveClientDisplay(c.env.DB, c.get('tenant'), {
    clientId: consent.clientId,
    projectId: application?.projectId ?? null,
  })
  return {
    clientId: consent.clientId,
    name: display.clientName,
    logoUrl: display.clientLogoUrl,
    redirectOrigin: redirectOriginOf(application),
    grantedScopes: consent.grantedScopes,
    createdAt: consent.createdAt.toISOString(),
    updatedAt: consent.updatedAt.toISOString(),
  }
}

const app = new Hono<XidHonoEnv>()

app.get('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const consents = await readAllById((cursor, limit) => {
    const own = eq(schema.oauthConsents.userId, session.userId)
    return db.oauthConsents.findMany(cursor ? and(own, gt(schema.oauthConsents.id, cursor)) : own, {
      orderBy: asc(schema.oauthConsents.id),
      limit,
    })
  })
  const clientIds = [...new Set(consents.map((consent) => consent.clientId))]
  const applications =
    clientIds.length === 0
      ? []
      : await db.applications.findMany(inArray(schema.applications.clientId, clientIds), {
          limit: clientIds.length,
        })
  const applicationByClientId = new Map(applications.map((row) => [row.clientId, row]))
  const items = await Promise.all(
    consents.map((consent) =>
      toAuthorizedApp(c, consent, applicationByClientId.get(consent.clientId)),
    ),
  )
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return c.json(items)
})

app.delete('/:clientId', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const clientId = c.req.param('clientId')
  const where = and(
    eq(schema.oauthConsents.userId, session.userId),
    eq(schema.oauthConsents.clientId, clientId),
  )
  const existing = await db.oauthConsents.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await requireStepUp(c, tenant, session)

  await db.oauthConsents.hardDelete(where)
  await revokeUserCredentials(c.env, tenant, session.userId, { clientId })
  await c.env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'consent.revoked',
    actorId: session.userId,
    ts: Date.now(),
    payload: { targetType: 'application', targetId: clientId },
  })
  return new Response(null, { status: 204 })
})

export function registerAuthorizedAppsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/authorized-apps', app)
}
