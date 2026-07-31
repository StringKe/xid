// POST /v1/sessions/active selects one browser-held session without exposing refresh credentials.
// The target cookie plus its D1/SessionDO checks authenticate the switch; sessionId is only a selector.

import type { ActiveSessionResponse } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import { setActiveSessionCookie } from '../lib/cookies'
import { AppError } from '../lib/errors'
import { isPersistedId } from '../lib/persisted-id'
import { selectSessionById } from '../lib/session'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, uuidSchema, validateBody } from '../lib/validate'

const activeSessionBodySchema = v.object({
  sessionId: v.pipe(
    v.string(),
    v.check(
      (value) => isPersistedId('session', value) || v.safeParse(uuidSchema, value).success,
      'Invalid session identifier',
    ),
  ),
})

function validationError(): AppError {
  return new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName: 'sessionId' },
  })
}

export async function handleActiveSession(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok || typeof json.value !== 'object' || json.value === null) throw validationError()
  const { sessionId } = validateBody(activeSessionBodySchema, json.value)

  const session = await selectSessionById(c, sessionId)
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })

  setActiveSessionCookie(c, session.sessionId)
  const response: ActiveSessionResponse = { activeSessionId: session.sessionId }
  return c.json(response)
}
