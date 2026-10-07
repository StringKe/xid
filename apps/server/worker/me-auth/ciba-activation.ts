// GET/POST /auth/ciba-activation -- authenticated end-user approval for CIBA backchannel requests.
// 只有 login_hint 指向的本人能查看和处理请求;其余情况与请求不存在返回同一个 invalid_request。

import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { approveCibaRequest, denyCibaRequest, lookupOwnedPendingCibaRequest } from '../oidc/ciba'
import { resolveClientDisplay } from '../oidc/client-display'
import { findClient } from '../oidc/shared'
import { firstIssuePath, readJsonBody } from '../lib/validate'
import { requireSession } from './shared'

const cibaActivationBodySchema = v.object({
  authReqId: v.string(),
  approved: v.optional(v.boolean()),
})

const cibaActivationQuerySchema = v.object({
  auth_req_id: v.string(),
})

function invalidAuthReqIdError(paramName: string): AppError {
  return new AppError('invalid_request', { meta: { paramName } })
}

// GET /auth/ciba-activation?auth_req_id= -- return pending request metadata for consent UI.
export async function handleCibaActivationParams(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const query = v.safeParse(cibaActivationQuerySchema, {
    auth_req_id: c.req.query('auth_req_id'),
  })
  if (!query.success) throw invalidAuthReqIdError('auth_req_id')
  const authReqId = query.output.auth_req_id.trim()
  if (!authReqId) throw invalidAuthReqIdError('auth_req_id')
  const record = await lookupOwnedPendingCibaRequest({
    env: c.env,
    ctx: c.get('tenant'),
    authReqId,
    userId: session.userId,
  })
  if (!record) throw new AppError('invalid_request')
  const client = await findClient(c, record.clientId)
  if (!client) throw new AppError('invalid_client', { httpStatus: 400 })
  const display = await resolveClientDisplay(c.env.DB, c.get('tenant'), client)
  return c.json({
    authReqId,
    clientId: client.clientId,
    clientName: display.clientName,
    clientLogoUrl: display.clientLogoUrl,
    scope: record.scope,
    expiresAt: new Date(record.expiresAt * 1000).toISOString(),
    firstParty: client.firstParty,
  })
}

// POST /auth/ciba-activation { authReqId, approved } -- approve or deny a pending CIBA request.
export async function handleCibaActivation(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw invalidAuthReqIdError('authReqId')
  const parsed = v.safeParse(cibaActivationBodySchema, json.value)
  if (!parsed.success) {
    const paramName = firstIssuePath(parsed.issues)
    if (paramName.split('.')[0] === 'authReqId') throw invalidAuthReqIdError('authReqId')
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  const authReqId = parsed.output.authReqId.trim()
  if (!authReqId) throw invalidAuthReqIdError('authReqId')
  const approved = parsed.output.approved === true
  const owner = { env: c.env, ctx: c.get('tenant'), authReqId, userId: session.userId }
  const handled = approved ? await approveCibaRequest(owner) : await denyCibaRequest(owner)
  if (!handled) throw new AppError('invalid_request')
  return c.json({ approved })
}
