// Account portal listing: the active SWA connections of the organizations the signed-in user is an
// active member of, with whether the user has saved credentials for each.

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { requireSession } from '../me/shared'
import { readLegacyConfigFromMapping } from './legacy-config'
import { isUsableLegacyTargetUrl } from './legacy-target-url'
import { openSwaCredential } from './swa-vault'

export type SwaMemberApp = {
  id: string
  orgId: string
  organizationName: string
  name: string | null
  targetOrigin: string
  stored: boolean
  username: string | null
}

export async function listSwaMemberApps(c: Context<XidHonoEnv>): Promise<SwaMemberApp[]> {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const memberships = await db.memberships.findMany(
    and(eq(schema.memberships.userId, session.userId), eq(schema.memberships.status, 'active')),
  )
  const orgIds = memberships.map((membership) => membership.orgId)
  if (orgIds.length === 0) return []

  const [connections, organizations, credentials] = await Promise.all([
    db.ssoConnections.findMany(
      and(
        inArray(schema.ssoConnections.orgId, orgIds),
        eq(schema.ssoConnections.protocol, 'swa'),
        eq(schema.ssoConnections.status, 'active'),
      ),
    ),
    db.organizations.findMany(inArray(schema.organizations.id, orgIds)),
    db.swaCredentials.findMany(eq(schema.swaCredentials.userId, session.userId)),
  ])
  const orgNames = new Map(organizations.map((org) => [org.id, org.name]))
  const credentialByConnection = new Map(credentials.map((row) => [row.connectionId, row]))

  const apps: SwaMemberApp[] = []
  for (const connection of connections) {
    const targetUrl = readLegacyConfigFromMapping(connection.attributeMapping).swaTargetUrl
    if (!isUsableLegacyTargetUrl(targetUrl)) continue
    const row = credentialByConnection.get(connection.id)
    const credential = row ? await openSwaCredential(c.env, row) : null
    apps.push({
      id: connection.id,
      orgId: connection.orgId,
      organizationName: orgNames.get(connection.orgId) ?? '',
      name: connection.displayName,
      targetOrigin: new URL(targetUrl).origin,
      stored: credential !== null,
      username: credential?.username ?? null,
    })
  }
  return apps
}
