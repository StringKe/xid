// GET/POST /auth/ciba-activation — authenticated end-user approval for CIBA backchannel requests.

import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { approveCibaRequest, denyCibaRequest, lookupCibaRequest } from '../oidc/ciba'
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
  return new AppError('invalid_request', {
    meta: { paramName },
    longMessage: `${paramName} is required`,
  })
}

// GET /auth/ciba-activation?auth_req_id= — return pending request metadata for consent UI.
export async function handleCibaActivationParams(c: Context<XidHonoEnv>): Promise<Response> {
  await requireSession(c)
  const query = v.safeParse(cibaActivationQuerySchema, {
    auth_req_id: c.req.query('auth_req_id'),
  })
  if (!query.success) throw invalidAuthReqIdError('auth_req_id')
  const authReqId = query.output.auth_req_id.trim()
  if (!authReqId) throw invalidAuthReqIdError('auth_req_id')
  const tenant = c.get('tenant')
  const record = await lookupCibaRequest(c.env, tenant.tenantId, authReqId)
  if (!record || record.status !== 'pending') {
    throw new AppError('invalid_request', { longMessage: 'CIBA request not found or not pending' })
  }
  const client = await findClient(c, record.clientId)
  if (!client) throw new AppError('invalid_client', { httpStatus: 400 })
  return c.json({
    authReqId,
    clientId: client.clientId,
    scope: record.scope,
    loginHint: record.loginHint,
    expiresAt: new Date(record.expiresAt * 1000).toISOString(),
    firstParty: client.firstParty,
  })
}

// POST /auth/ciba-activation { authReqId, approved } — approve or deny a pending CIBA request.
export async function handleCibaActivation(c: Context<XidHonoEnv>): Promise<Response> {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const json = await readJsonBody(c)
  if (!json.ok) throw invalidAuthReqIdError('authReqId')
  const parsed = v.safeParse(cibaActivationBodySchema, json.value)
  if (!parsed.success) {
    const paramName = firstIssuePath(parsed.issues)
    if (paramName.split('.')[0] === 'authReqId') throw invalidAuthReqIdError('authReqId')
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  const body = parsed.output
  const authReqId = body.authReqId.trim()
  if (!authReqId) throw invalidAuthReqIdError('authReqId')
  if (body.approved === true) {
    const ok = await approveCibaRequest({
      env: c.env,
      ctx: tenant,
      authReqId,
      userId: session.userId,
    })
    if (!ok) {
      throw new AppError('invalid_request', {
        longMessage: 'CIBA request not found, expired, or login_hint mismatch',
      })
    }
    return c.json({ approved: true })
  }
  const denied = await denyCibaRequest({
    env: c.env,
    tenantId: tenant.tenantId,
    authReqId,
  })
  if (!denied) {
    throw new AppError('invalid_request', { longMessage: 'CIBA request not found or not pending' })
  }
  return c.json({ approved: false })
}
