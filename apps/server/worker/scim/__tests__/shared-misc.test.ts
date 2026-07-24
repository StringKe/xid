// SCIM shared 补充单元测试:scimError 响应体与 parseScimEqFilter。
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { emitWebhookAsync, parseScimEqFilter, scimError } from '../shared'

describe('scimError', () => {
  it('returns SCIM JSON error with optional scimType and WWW-Authenticate', async () => {
    const app = new Hono<XidHonoEnv>()
    app.get('/err', (c) =>
      scimError(c, 401, 'Unauthorized', { scimType: 'invalidToken', addWwwAuth: true }),
    )
    const res = await app.request('/err')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/scim+json')
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    const body = (await res.json()) as {
      schemas: string[]
      detail: string
      status: string
      scimType?: string
    }
    expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error')
    expect(body.detail).toBe('Unauthorized')
    expect(body.status).toBe('401')
    expect(body.scimType).toBe('invalidToken')
  })
})

describe('parseScimEqFilter', () => {
  it('returns null value when filter absent', () => {
    expect(parseScimEqFilter(undefined, 'userName')).toEqual({ ok: true, value: null })
  })

  it('parses attribute eq "value" filter', () => {
    expect(parseScimEqFilter('userName eq "alice@example.com"', 'userName')).toEqual({
      ok: true,
      value: 'alice@example.com',
    })
  })

  it('rejects malformed filter syntax', () => {
    expect(parseScimEqFilter('userName co "alice"', 'userName')).toEqual({ ok: false })
  })
})

describe('emitWebhookAsync', () => {
  it('registers rejected queue work with the request execution context', async () => {
    const rejection = Promise.resolve().then(() => {
      throw new Error('queue unavailable')
    })
    const waitUntil = vi.fn()
    const c = {
      env: { WEBHOOK_QUEUE: { send: vi.fn(() => rejection) } },
      executionCtx: { waitUntil },
    } as unknown as Context<XidHonoEnv>

    emitWebhookAsync(c, { tenantId: 't_1', event: 'user.deactivated', payload: {} })

    expect(waitUntil).toHaveBeenCalledWith(rejection)
    await expect(rejection).rejects.toThrow('queue unavailable')
  })
})
