// 未命中协议前缀 404 blocker:/scim/ 前缀回 SCIM Error 形状(RFC7644 3.12),其余前缀回 XidAPIError JSON。

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerUnmatchedProtocolBlocker } from '../unmatched-protocol'
import type { XidHonoEnv } from '../types'

function makeApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  registerUnmatchedProtocolBlocker(app)
  return app
}

describe('unmatched protocol blocker', () => {
  it('/scim/ 未知路径 -> 404 scimError 形状', async () => {
    const res = await makeApp().request('https://acme.xid.dev/scim/v2/organizations/t_1/Unknown')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/scim+json')
    const body = (await res.json()) as { schemas: string[]; detail: string; status: string }
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error'])
    expect(body.status).toBe('404')
    expect(body.detail).toBeTypeOf('string')
  })

  it('/v1/ 未知路径 -> 404 XidAPIError JSON', async () => {
    const res = await makeApp().request('https://acme.xid.dev/v1/unknown')

    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('not_found')
  })

  it('非协议前缀路径不被拦截', async () => {
    const res = await makeApp().request('https://acme.xid.dev/sign-in')

    // 无后续处理器,Hono 默认 404;关键是没被套用 scimError / not_found JSON 形状。
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).not.toContain('urn:ietf:params:scim')
    expect(body).not.toContain('not_found')
  })
})
