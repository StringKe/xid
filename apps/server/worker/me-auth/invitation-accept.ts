// 组织邀请兼容入口:raw token 仅预览，旧接受端点始终 fail closed。

import { createTenantDb } from '@xid-kit/db'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { loadInvitationPreview, resolveInvitationTenant } from '../auth/invitations'
import { validateQuery } from '../lib/validate'
const previewQuerySchema = v.object({
  token: v.optional(v.string()),
})

function invalidPreview(): {
  status: 'invalid'
  email: null
  orgId: null
  orgName: null
  role: null
  expiresAt: null
} {
  return {
    status: 'invalid',
    email: null,
    orgId: null,
    orgName: null,
    role: null,
    expiresAt: null,
  }
}

export async function handleInvitationPreview(c: Context<XidHonoEnv>): Promise<Response> {
  const query = validateQuery(previewQuerySchema, {
    token: c.req.query('token'),
  })
  const rawToken = query.token ?? ''
  const tenant = await resolveInvitationTenant(c, rawToken)
  if (!tenant) return c.json(invalidPreview())
  const db = createTenantDb(c.env.DB, tenant)
  const preview = await loadInvitationPreview(db, rawToken)
  return c.json(preview)
}

export async function handleInvitationAccept(_c: Context<XidHonoEnv>): Promise<Response> {
  // Raw invitation acceptance and legacy session continuations cannot prove that every existing
  // credential was created after Email ownership. All acceptance now goes through the one-time
  // invitation Email claim, which binds acceptance to a claim-proven identity.
  throw new AppError('invitation_invalid')
}

export async function applyInvitationAfterSession(
  _c: Context<XidHonoEnv>,
  _session: SessionData,
  _rawToken: string,
): Promise<string | null> {
  return null
}
