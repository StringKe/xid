// GNAP / UMA / HEART / OID4VP / OID4VCI minimal route stubs with negative validation.

import * as v from 'valibot'
import type { Context, Hono } from 'hono'
import { readJsonBody } from '../lib/validate'
import type { XidHonoEnv } from '../lib/types'
import { oauthError, oauthInvalidRequest } from './shared'

// stub 端点只要求"JSON 对象"形状;字段级存在性守卫保持手写(truthy 语义,schema 无法等价表达)。
const jsonObjectSchema = v.record(v.string(), v.unknown())

async function requireJson(c: Context<XidHonoEnv>): Promise<Record<string, unknown> | Response> {
  const body = await readJsonBody(c)
  if (!body.ok) {
    return oauthError(c, {
      status: 400,
      error: 'invalid_request',
      description: 'JSON body required',
    })
  }
  const parsed = v.safeParse(jsonObjectSchema, body.value)
  if (!parsed.success) return oauthInvalidRequest(c, parsed.issues)
  return parsed.output
}

function notImplemented(c: Context<XidHonoEnv>, feature: string): Response {
  return oauthError(c, {
    status: 501,
    error: 'unsupported_feature',
    description: `${feature} subset is not enabled for this request`,
  })
}

export function registerOptionalProtocolRoutes(app: Hono<XidHonoEnv>): void {
  app.post('/gnap', async (c) => {
    const body = await requireJson(c)
    if (body instanceof Response) return body
    if (!body['access']) return notImplemented(c, 'GNAP grant')
    return notImplemented(c, 'GNAP grant')
  })
  app.post('/gnap/tx', async (c) => notImplemented(c, 'GNAP continue'))

  app.post('/uma/resource_set', async (c) => {
    const body = await requireJson(c)
    if (body instanceof Response) return body
    if (!body['name']) {
      return oauthError(c, { status: 400, error: 'invalid_request', description: 'name required' })
    }
    return c.json({ _id: 'rs_stub', name: body['name'] }, 201)
  })
  app.post('/uma', async (c) => notImplemented(c, 'UMA permission ticket'))

  app.get('/heart/metadata', async (c) =>
    c.json(
      {
        issuer: c.get('tenant').issuer,
        scopes_supported: ['patient/*.read', 'openid', 'fhirUser'],
        claims_supported: ['fhirUser', 'patient'],
      },
      200,
    ),
  )
  app.post('/heart', async (c) => notImplemented(c, 'HEART token profile'))

  app.post('/oid4vp/request', async (c) => {
    const body = await requireJson(c)
    if (body instanceof Response) return body
    if (!body['presentation_definition']) {
      return oauthError(c, {
        status: 400,
        error: 'invalid_request',
        description: 'presentation_definition required',
      })
    }
    return c.json({ request_uri: `${c.get('tenant').issuer}/oid4vp/request/stub` }, 201)
  })
  app.post('/oid4vp', async (c) => notImplemented(c, 'OID4VP presentation'))

  app.post('/oid4vci/credential', async (c) => {
    const body = await requireJson(c)
    if (body instanceof Response) return body
    if (!body['credential_configuration_id']) {
      return oauthError(c, {
        status: 400,
        error: 'invalid_request',
        description: 'credential_configuration_id required',
      })
    }
    return notImplemented(c, 'OID4VCI credential issuance')
  })
  app.post('/oid4vci', async (c) => notImplemented(c, 'OID4VCI pre-authorized flow'))
}
