import { describe, expect, it } from 'vitest'
import { parseAuthzRequestId, peekStashedAuthorizeParams } from '../pending-params'

describe('pending-params', () => {
  it('parseAuthzRequestId extracts authz_request_id from redirect_to', () => {
    expect(parseAuthzRequestId('/authorize?authz_request_id=authz_1')).toBe('authz_1')
  })

  it('peekStashedAuthorizeParams returns stashed params without consuming', async () => {
    const pending = { acr_values: 'urn:xid:aal3', require_aal3: '1' }
    const env = {
      OAUTH_STATE: {
        idFromName: () => ({ toString: () => 'oauth-id' }) as DurableObjectId,
        get: () =>
          ({
            fetch: async (input: string | Request) => {
              const rawUrl = typeof input === 'string' ? input : input.url
              const url = new URL(rawUrl)
              if (url.pathname === '/consume') {
                return new Response(JSON.stringify({ record: { pendingParams: pending } }), {
                  status: 200,
                })
              }
              if (url.pathname === '/store') return new Response(null, { status: 201 })
              return new Response(null, { status: 404 })
            },
          }) as unknown as DurableObjectStub,
      } as unknown as DurableObjectNamespace,
    } as unknown as Env

    const result = await peekStashedAuthorizeParams(env, 'tenant-1', 'authz_1')
    expect(result).toEqual(pending)
  })
})
