// OpenID Federation minimal metadata and registration endpoints.

import * as v from 'valibot'
import type { Hono } from 'hono'
import { readJsonBody } from '../lib/validate'
import type { XidHonoEnv } from '../lib/types'
import { requireOidcManagementAuth } from './management-auth'
import { oauthError, oauthInvalidRequest } from './shared'
import { FEDERATION_ANCHORS_CACHE_TTL_SEC } from '../lib/ttl'

// 顶层形状:只卡字段类型与存在性;keys 元素(JWK)不深入校验(现状也只查非空数组)。
const federationRegistrationSchema = v.object({
  entity_id: v.string(),
  jwks: v.object({ keys: v.pipe(v.array(v.unknown()), v.minLength(1)) }),
})

type TrustAnchor = {
  entityId: string
  jwks: { keys: unknown[] }
}

function federationCacheKey(instanceId: string): string {
  return `federation:anchors:${instanceId}`
}

async function loadTrustAnchors(env: Env, instanceId: string): Promise<TrustAnchor[]> {
  const raw = await env.CACHE.get(federationCacheKey(instanceId), 'json')
  return Array.isArray(raw) ? (raw as TrustAnchor[]) : []
}

export function registerFederationRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/.well-known/openid-federation', async (c) => {
    const ctx = c.get('tenant')
    const anchors = await loadTrustAnchors(c.env, ctx.tenantId)
    return c.json(
      {
        issuer: ctx.issuer,
        federation_registration_endpoint: `${ctx.issuer}/federation_registration`,
        trust_mark_issuers: anchors.map((a) => a.entityId),
        authority_hints: [ctx.issuer],
      },
      200,
      { 'cache-control': 'public, max-age=3600' },
    )
  })

  app.post('/federation_registration', async (c) => {
    const authErr = await requireOidcManagementAuth(c)
    if (authErr) return authErr
    const body = await readJsonBody(c)
    if (!body.ok) {
      return oauthError(c, {
        status: 400,
        error: 'invalid_request',
        description: 'Request body must be JSON',
      })
    }
    const parsed = v.safeParse(federationRegistrationSchema, body.value)
    if (!parsed.success) return oauthInvalidRequest(c, parsed.issues)
    const { entity_id: entityId, jwks } = parsed.output
    const ctx = c.get('tenant')
    const anchors = await loadTrustAnchors(c.env, ctx.tenantId)
    const next = anchors.filter((a) => a.entityId !== entityId)
    next.push({ entityId, jwks })
    await c.env.CACHE.put(federationCacheKey(ctx.tenantId), JSON.stringify(next), {
      expirationTtl: FEDERATION_ANCHORS_CACHE_TTL_SEC,
    })
    return c.json({ entity_id: entityId, status: 'registered' }, 201, {
      'cache-control': 'no-store',
    })
  })
}
