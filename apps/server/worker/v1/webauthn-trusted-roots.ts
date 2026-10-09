// /v1/webauthn/trusted-roots:租户的 passkey attestation 可信根(direct 策略必需,indirect 用于标记已验证)。
// 存 KV `webauthn:trusted_roots:{tenantId}`,注册仪式读取;写入走 Management API 守卫(API key 或顶层组织管理员)。
// 只接受当前有效的 CA 证书;响应只返回指纹与有效期,不回显证书正文。

import {
  certificateFingerprint,
  parseTrustedRoots,
  type ParsedCertificate,
} from '@xid-kit/webauthn'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { auditActorId, emitManagementAuditAsync, requireApiKeyOrTopLevelOrgManager } from './shared'

const MAX_TRUSTED_ROOTS = 20
const MAX_PEM_LENGTH = 64 * 1024

export const WEBAUTHN_TRUSTED_ROOTS_UPDATED_EVENT = 'organization.webauthn_trusted_roots.updated'

export function trustedRootsKvKey(tenantId: string): string {
  return `webauthn:trusted_roots:${tenantId}`
}

const putBodySchema = v.object({
  pem: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_PEM_LENGTH)),
})

type TrustedRootView = { fingerprint: string; notBefore: string; notAfter: string }

function invalidPem(): AppError {
  return new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'pem' } })
}

function parseRootBundle(pem: string, now: Date): ParsedCertificate[] {
  let roots: ParsedCertificate[]
  try {
    roots = parseTrustedRoots([pem])
  } catch (error) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'pem' },
      cause: error,
    })
  }
  if (roots.length === 0 || roots.length > MAX_TRUSTED_ROOTS) throw invalidPem()
  const usable = roots.every(
    (root) =>
      root.basicConstraints?.isCa === true &&
      root.notBefore.getTime() <= now.getTime() &&
      now.getTime() <= root.notAfter.getTime(),
  )
  if (!usable) throw invalidPem()
  return roots
}

async function toViews(roots: readonly ParsedCertificate[]): Promise<TrustedRootView[]> {
  return Promise.all(
    roots.map(async (root) => ({
      fingerprint: await certificateFingerprint(root.der),
      notBefore: root.notBefore.toISOString(),
      notAfter: root.notAfter.toISOString(),
    })),
  )
}

async function storedViews(pem: string | null): Promise<TrustedRootView[]> {
  if (!pem) return []
  return toViews(parseTrustedRoots([pem]))
}

// 实例级根(Workers 变量 WEBAUTHN_TRUSTED_ROOTS_PEM)与租户经本端点配置的根都可用;
// 注册仪式、auth-policy 的 direct 前置检查与本端点的 configured 统一从这里取。
export async function loadTrustedAttestationRoots(env: Env, tenantId: string): Promise<string[]> {
  const tenantRoots = await env.CACHE.get(trustedRootsKvKey(tenantId))
  return [env.WEBAUTHN_TRUSTED_ROOTS_PEM, tenantRoots].filter(
    (pem): pem is string => typeof pem === 'string' && pem.length > 0,
  )
}

const app = new Hono<XidHonoEnv>()

// data 只列本租户配置的根;configured 同时计入实例级根,与注册仪式实际可用的根一致。
app.get('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'organizations:read')
  const tenant = c.get('tenant')
  const roots = await storedViews(await c.env.CACHE.get(trustedRootsKvKey(tenant.tenantId)))
  const instanceConfigured = Boolean(c.env.WEBAUTHN_TRUSTED_ROOTS_PEM)
  return c.json({ configured: roots.length > 0 || instanceConfigured, data: roots })
})

app.put('/', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'organizations:write')
  const tenant = c.get('tenant')
  const json = await readJsonBody(c)
  if (!json.ok) throw invalidPem()
  const body = validateBody(putBodySchema, json.value)
  const roots = parseRootBundle(body.pem, new Date())
  await c.env.CACHE.put(trustedRootsKvKey(tenant.tenantId), body.pem)
  const data = await toViews(roots)
  emitManagementAuditAsync(c, {
    action: WEBAUTHN_TRUSTED_ROOTS_UPDATED_EVENT,
    actorId: auditActorId(auth),
    orgId: tenant.tenantId,
    targetType: 'organization',
    targetId: tenant.tenantId,
    details: { fingerprints: data.map((root) => root.fingerprint) },
  })
  return c.json({ configured: true, data })
})

app.delete('/', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'organizations:write')
  const tenant = c.get('tenant')
  await c.env.CACHE.delete(trustedRootsKvKey(tenant.tenantId))
  emitManagementAuditAsync(c, {
    action: WEBAUTHN_TRUSTED_ROOTS_UPDATED_EVENT,
    actorId: auditActorId(auth),
    orgId: tenant.tenantId,
    targetType: 'organization',
    targetId: tenant.tenantId,
    details: { fingerprints: [] },
  })
  return new Response(null, { status: 204 })
})

export function registerWebAuthnTrustedRootRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/webauthn/trusted-roots', app)
}
