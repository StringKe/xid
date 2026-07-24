// 已登录用户自助创建组织:写 org 行 + owner membership + 切换 active org。

import { createTenantDb, schema } from '@xid-kit/db'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { invitationAcceptContinuePath } from '../auth/invitations'
import { readJsonBody, slugSchema, validateBody } from '../lib/validate'
import { emitWebhookAsync } from '../v1/shared'
import { checkRateLimit, ORG_CREATE_PER_DAY_POLICY, requireSession } from './shared'

const createOrgBodySchema = v.object({
  slug: v.optional(v.string()),
  name: v.optional(v.string()),
})

function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function defaultOrgMetadata(): Record<string, unknown> {
  return { hostedAuth: DEFAULT_HOSTED_AUTH_POLICY }
}

export async function handleSelfOrganizationCreate(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const allowed = await checkRateLimit(
    c.env,
    `org_create:day:${tenant.tenantId}:${session.userId}`,
    ORG_CREATE_PER_DAY_POLICY,
  )
  if (!allowed) throw new AppError('rate_limited')

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createOrgBodySchema, json.value)
  const name = (body.name ?? '').trim()
  // slug 先 normalize 再按 slugSchema 断言:用户给 display 形态("Acme Corp!")也能落成合法 slug。
  const slug = normalizeSlug((body.slug ?? name).trim())
  if (!name || !v.safeParse(slugSchema, slug).success) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      longMessage: 'slug and name are required.',
    })
  }

  const db = createTenantDb(c.env.DB, tenant)
  const existing = await db.organizations.findOne(eq(schema.organizations.slug, slug))
  if (existing && existing.status !== 'deleted') {
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'slug' } })
  }

  const instanceId = tenant.instanceId ?? tenant.tenantId
  const orgId = crypto.randomUUID()
  const org = await db.organizations.insert({
    id: orgId,
    tenantId: tenant.tenantId,
    instanceId,
    slug,
    name,
    publicMetadata: {},
    privateMetadata: defaultOrgMetadata(),
    enrollmentMode: 'invite_required',
    allowOrgSelfService: true,
    status: 'active',
  })

  const membershipId = crypto.randomUUID()
  await db.forOrg(orgId).memberships.insert({
    id: membershipId,
    tenantId: tenant.tenantId,
    orgId,
    userId: session.userId,
    role: 'owner',
    membershipType: 'member',
    status: 'active',
    joinedAt: new Date(),
  })

  await db.sessions.update(
    { activeOrgId: orgId },
    and(
      eq(schema.sessions.id, session.sessionId),
      eq(schema.sessions.userId, session.userId),
      eq(schema.sessions.status, 'active'),
    ),
  )

  emitWebhookAsync(c.env, {
    tenantId: tenant.tenantId,
    event: 'organization.created',
    payload: { orgId },
  })
  emitWebhookAsync(c.env, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.created',
    payload: { orgId, userId: session.userId },
  })

  return c.json(
    {
      id: org.id,
      slug: org.slug,
      name: org.name,
      role: 'owner',
      redirectUrl: invitationAcceptContinuePath(orgId, org.name),
    },
    201,
  )
}
