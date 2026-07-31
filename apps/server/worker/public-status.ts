import { schema } from '@xid-kit/db'
import { desc, inArray, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { XidHonoEnv } from './lib/types'
import { managementDb } from './platform/shared'

const app = new Hono<XidHonoEnv>()

type PublicIncidentStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage'

export function overallStatus(impacts: readonly string[]): PublicIncidentStatus {
  if (impacts.includes('critical')) return 'major_outage'
  if (impacts.includes('major')) return 'partial_outage'
  if (impacts.includes('minor')) return 'degraded'
  return 'operational'
}

app.get('/', async (c) => {
  const db = managementDb(c.env)
  const [incidents, activeIncidents] = await Promise.all([
    db
      .select()
      .from(schema.statusIncidents)
      .orderBy(desc(schema.statusIncidents.startedAt), desc(schema.statusIncidents.id))
      .limit(50),
    db
      .select({ impact: schema.statusIncidents.impact })
      .from(schema.statusIncidents)
      .where(ne(schema.statusIncidents.status, 'resolved')),
  ])
  const incidentIds = incidents.map((incident) => incident.id)
  const updates =
    incidentIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.statusIncidentUpdates)
          // The public list is bounded to 50; Drizzle emits one bound placeholder per id.
          .where(inArray(schema.statusIncidentUpdates.incidentId, incidentIds))
          .orderBy(
            desc(schema.statusIncidentUpdates.createdAt),
            desc(schema.statusIncidentUpdates.id),
          )
  const updatesByIncident = new Map<
    string,
    Array<{
      id: string
      status: string
      message: string
      createdAt: string
    }>
  >()
  for (const update of updates) {
    const list = updatesByIncident.get(update.incidentId) ?? []
    list.push({
      id: update.id,
      status: update.status,
      message: update.message,
      createdAt: update.createdAt.toISOString(),
    })
    updatesByIncident.set(update.incidentId, list)
  }

  const updatedAt = incidents.reduce(
    (latest, incident) => Math.max(latest, incident.updatedAt.getTime()),
    0,
  )
  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  return c.json({
    status: overallStatus(activeIncidents.map((incident) => incident.impact)),
    updatedAt: updatedAt === 0 ? null : new Date(updatedAt).toISOString(),
    incidents: incidents.map((incident) => ({
      id: incident.id,
      title: incident.title,
      status: incident.status,
      impact: incident.impact,
      summary: incident.summary,
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      updates: updatesByIncident.get(incident.id) ?? [],
    })),
  })
})

export function registerPublicStatusRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/public/status', app)
}
