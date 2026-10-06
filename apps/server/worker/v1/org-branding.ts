// /v1/organizations/:id/branding 与 /logo。品牌存于 organizations.private_metadata.branding,
// TenantContext.policy.branding 读取同一份数据下发给 Hosted UI;logo 同步写 organizations.logo_url 供 consent 页使用。

import { createTenantDb, schema } from '@xid-kit/db'
import {
  DEFAULT_ORG_BRANDING,
  ORG_BRANDING_FIELDS,
  hasCustomBranding,
  isBrandColor,
  isBrandFontFamily,
  isBrandLogoUrl,
  isBrandRadius,
  normalizeOrgBranding,
  type OrgBranding,
} from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody, validateBody } from '../lib/validate'
import { auditOrgMutation, toOrganizationResponse } from './org-shared'
import { requireApiKey, requireApiKeyOrOrgManager, requireOrg, type OrgScopedAuth } from './shared'

const app = new Hono<XidHonoEnv>()
const LOGO_MAX_BYTES = 5 * 1024 * 1024

function brandField(check: (value: string) => boolean) {
  return v.optional(v.nullable(v.pipe(v.string(), v.check(check))))
}

const brandLogoField = v.optional(v.nullable(v.pipe(publicHttpsUrlSchema, v.check(isBrandLogoUrl))))

// 字段缺省表示保留当前值,null 表示清除。
const brandingPatchBodySchema = v.object({
  primaryColor: brandField(isBrandColor),
  backgroundColor: brandField(isBrandColor),
  accentColor: brandField(isBrandColor),
  borderRadius: brandField(isBrandRadius),
  fontFamily: brandField(isBrandFontFamily),
  logoUrl: brandLogoField,
  logoDarkUrl: brandLogoField,
})

type BrandingPatch = v.InferOutput<typeof brandingPatchBodySchema>

function privateMetadataOf(org: typeof schema.organizations.$inferSelect): Record<string, unknown> {
  const value = org.privateMetadata
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function legacyBrandingKey(tenantId: string, orgId: string): string {
  return `brand:${tenantId}:${orgId}`
}

// v0.0.8 及更早版本只把品牌写在 CACHE KV、logo 只写在 organizations.logo_url;
// D1 尚无品牌记录时合并这两处旧值,下一次保存迁入 D1。
async function readBranding(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<OrgBranding> {
  const metadata = privateMetadataOf(org)
  if (metadata['branding'] !== undefined) return normalizeOrgBranding(metadata['branding'])
  const legacy = await readLegacyKvBranding(c, org)
  if (legacy.logoUrl === null && org.logoUrl && isBrandLogoUrl(org.logoUrl)) {
    return { ...legacy, logoUrl: org.logoUrl }
  }
  return legacy
}

async function readLegacyKvBranding(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
): Promise<OrgBranding> {
  const legacy = await c.env.CACHE.get(legacyBrandingKey(org.tenantId, org.id))
  if (!legacy) return DEFAULT_ORG_BRANDING
  try {
    return normalizeOrgBranding(JSON.parse(legacy))
  } catch {
    return DEFAULT_ORG_BRANDING
  }
}

function mergeBranding(current: OrgBranding, patch: BrandingPatch): OrgBranding {
  const next = { ...current }
  for (const field of ORG_BRANDING_FIELDS) {
    const value = patch[field]
    if (value !== undefined) next[field] = value
  }
  return next
}

async function writeBranding(
  c: Context<XidHonoEnv>,
  org: typeof schema.organizations.$inferSelect,
  branding: OrgBranding,
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await db.organizations.update(
    {
      privateMetadata: {
        ...privateMetadataOf(org),
        branding: hasCustomBranding(branding) ? branding : null,
      },
      logoUrl: branding.logoUrl,
    },
    eq(schema.organizations.id, org.id),
  )
  await c.env.CACHE.delete(legacyBrandingKey(org.tenantId, org.id))
}

function auditBranding(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: { orgId: string; fields: readonly string[] },
): void {
  auditOrgMutation(c, auth, {
    action: 'organization.branding.updated',
    orgId: input.orgId,
    targetType: 'organization',
    targetId: input.orgId,
    details: { fields: input.fields },
  })
}

// GET /v1/organizations/:id/branding
app.get('/:id/branding', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'branding:read')
  return c.json(await readBranding(c, await requireOrg(c, id)))
})

// PATCH /v1/organizations/:id/branding
app.patch('/:id/branding', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'branding:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(brandingPatchBodySchema, json.value)
  const org = await requireOrg(c, id)
  const next = mergeBranding(await readBranding(c, org), body)
  await writeBranding(c, org, next)
  auditBranding(c, auth, {
    orgId: id,
    fields: ORG_BRANDING_FIELDS.filter((field) => body[field] !== undefined),
  })
  return c.json(next)
})

// PUT /v1/organizations/:id/logo  multipart/form-data (field: file)
app.put('/:id/logo', async (c) => {
  const key = await requireApiKey(c, 'organizations:write')
  const id = c.req.param('id')
  const org = await requireOrg(c, id)
  const tenant = c.get('tenant')

  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!(file instanceof File) || file.size > LOGO_MAX_BYTES) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'file' } })
  }

  const objectKey = `logos/${tenant.tenantId}/${id}/${crypto.randomUUID()}`
  await c.env.STORAGE.put(objectKey, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  })
  // logo 经 worker 自 serve(GET /storage/logos/*);issuer 随单租户/多租户/自定义域名解析。
  const logoUrl = `${tenant.issuer}/storage/${objectKey}`
  const branding = { ...(await readBranding(c, org)), logoUrl }
  await writeBranding(c, org, branding)
  auditBranding(
    c,
    { kind: 'api_key', apiKeyId: key.id, scopes: key.scopes },
    {
      orgId: id,
      fields: ['logoUrl'],
    },
  )
  return c.json({
    logo_url: logoUrl,
    organization: toOrganizationResponse(await requireOrg(c, id)),
  })
})

export function registerOrgBrandingRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
