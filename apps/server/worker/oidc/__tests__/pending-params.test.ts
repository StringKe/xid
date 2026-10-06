import { describe, expect, it } from 'vitest'
import { isAppError } from '../../lib/errors'
import { parseAuthzRequestId, peekStashedAuthorizeRecord } from '../pending-params'

const PENDING = { acr_values: 'urn:xid:aal2', state: 'state_1' }

describe('pending-params', () => {
  it('parseAuthzRequestId extracts authz_request_id from redirect_to', () => {
    expect(parseAuthzRequestId('/authorize?authz_request_id=authz_1')).toBe('authz_1')
  })

  it('peekStashedAuthorizeRecord returns stashed params without consuming', async () => {
    const result = await peekStashedAuthorizeRecord(makeEnv(PENDING, 201), 'tenant-1', 'authz_1')

    expect(result?.params).toEqual(PENDING)
    expect(result?.viaPar).toBe(false)
    expect(result?.consentDecision).toBeNull()
  })

  it('peekStashedAuthorizeRecord keeps server-side viaPar and consent decision', async () => {
    const consentDecision = { decision: 'approved', userId: 'u_1', sessionId: 's_1' }
    const body = JSON.stringify({
      record: { pendingParams: PENDING, viaPar: true, consentDecision },
    })

    const result = await peekStashedAuthorizeRecord(
      makeEnv(PENDING, 201, 200, body),
      'tenant-1',
      'authz_1',
    )

    expect(result?.viaPar).toBe(true)
    expect(result?.consentDecision).toEqual(consentDecision)
  })

  it('peekStashedAuthorizeRecord fails closed when consent decision is malformed', async () => {
    const body = JSON.stringify({
      record: { pendingParams: PENDING, consentDecision: { decision: 'maybe' } },
    })

    const caught = await captureError(() =>
      peekStashedAuthorizeRecord(makeEnv(PENDING, 201, 200, body), 'tenant-1', 'authz_1'),
    )

    expect(isAppError(caught)).toBe(true)
  })

  it('peekStashedAuthorizeRecord fails closed when restore store returns non-201', async () => {
    const caught = await captureError(() =>
      peekStashedAuthorizeRecord(makeEnv(PENDING, 500), 'tenant-1', 'authz_1'),
    )

    expect(isAppError(caught)).toBe(true)
    if (isAppError(caught)) expect(caught.code).toBe('server_error')
  })

  it('peekStashedAuthorizeRecord returns null when consume reports missing state', async () => {
    const result = await peekStashedAuthorizeRecord(
      makeEnv(PENDING, 201, 404),
      'tenant-1',
      'authz_1',
    )

    expect(result).toBeNull()
  })

  it('peekStashedAuthorizeRecord returns null when consume reports expired state', async () => {
    const result = await peekStashedAuthorizeRecord(
      makeEnv(PENDING, 201, 410),
      'tenant-1',
      'authz_1',
    )

    expect(result).toBeNull()
  })

  it('peekStashedAuthorizeRecord fails closed when consume returns unexpected status', async () => {
    const caught = await captureError(() =>
      peekStashedAuthorizeRecord(makeEnv(PENDING, 201, 500), 'tenant-1', 'authz_1'),
    )

    expect(isAppError(caught)).toBe(true)
    if (isAppError(caught)) expect(caught.code).toBe('server_error')
  })

  it('peekStashedAuthorizeRecord fails closed when consume body is not JSON', async () => {
    const caught = await captureError(() =>
      peekStashedAuthorizeRecord(makeEnv(PENDING, 201, 200, 'not json'), 'tenant-1', 'authz_1'),
    )

    expect(isAppError(caught)).toBe(true)
    if (isAppError(caught)) expect(caught.code).toBe('server_error')
  })

  it('peekStashedAuthorizeRecord fails closed when consume body is malformed', async () => {
    const caught = await captureError(() =>
      peekStashedAuthorizeRecord(
        makeEnv(PENDING, 201, 200, JSON.stringify({ record: null })),
        'tenant-1',
        'authz_1',
      ),
    )

    expect(isAppError(caught)).toBe(true)
    if (isAppError(caught)) expect(caught.code).toBe('server_error')
  })

  it('peekStashedAuthorizeRecord fails closed when pending params contain non-string value', async () => {
    const caught = await captureError(() =>
      peekStashedAuthorizeRecord(
        makeEnv(
          PENDING,
          201,
          200,
          JSON.stringify({ record: { pendingParams: { acr_values: 1 } } }),
        ),
        'tenant-1',
        'authz_1',
      ),
    )

    expect(isAppError(caught)).toBe(true)
    if (isAppError(caught)) expect(caught.code).toBe('server_error')
  })
})

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    return null
  } catch (err) {
    return err
  }
}

// consumeBody 传原始串(而非对象),这样能构造出非 JSON 的 DO 响应。
function makeEnv(
  pending: Record<string, string>,
  storeStatus: number,
  consumeStatus = 200,
  consumeBody = JSON.stringify({ record: { pendingParams: pending } }),
): Env {
  return {
    OAUTH_STATE: {
      idFromName: () => ({ toString: () => 'oauth-id' }) as DurableObjectId,
      get: () =>
        ({
          fetch: async (input: string | Request) => {
            const rawUrl = typeof input === 'string' ? input : input.url
            const url = new URL(rawUrl)
            if (url.pathname === '/consume') {
              return new Response(consumeBody, { status: consumeStatus })
            }
            if (url.pathname === '/store') return new Response(null, { status: storeStatus })
            return new Response(null, { status: 404 })
          },
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
  } as unknown as Env
}
