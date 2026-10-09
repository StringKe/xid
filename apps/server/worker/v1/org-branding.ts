// /v1/organizations/:id/branding 与 /logo。已发布品牌存于 organizations.private_metadata.branding,
// TenantContext.policy.branding 只读这一份下发给 Hosted UI;草稿存 brandingDraft,发布时才覆盖已发布版本,
// 并同步 organizations.logo_url 供 consent 页使用。

import { createTenantDb, schema } from '@xid-kit/db'
import {
  BRAND_COLOR_SCHEMES,
  BRAND_RADII,
  DEFAULT_ORG_BRANDING,
  ORG_BRANDING_FIELDS,
  brandAccentOf,
  hasCustomBranding,
  isBrandColor,
  isBrandFontFamily,
  isBrandLogoUrl,
  normalizeOrgBranding,
  sameOrgBranding,
  type OrgBranding,
} from '@xid-kit/types'
import {
  CONTROL_CONTRAST,
  TEXT_CONTRAST,
  contrastRatio,
  deriveAccentPalette,
  parseHexColor,
  type Rgb,
} from '@xid-kit/web-ui/brand-color'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { hostedAuthOrigin } from '../lib/hosted-origin'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { loadActorDisplays, type ActorDisplay } from './org-domains'
import { auditOrgMutation, toIso, toOrganizationResponse } from './org-shared'
import { auditActorId, requireApiKeyOrOrgManager, requireOrg, type OrgScopedAuth } from './shared'

const app = new Hono<XidHonoEnv>()
const LOGO_MAX_BYTES = 5 * 1024 * 1024
const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const DARK_SURFACE: Rgb = { r: 24, g: 24, b: 24 }

type OrgRow = typeof schema.organizations.$inferSelect

function brandField(check: (value: string) => boolean) {
  return v.optional(v.nullable(v.pipe(v.string(), v.check(check))))
}

const brandLogoField = v.optional(v.nullable(v.pipe(publicHttpsUrlSchema, v.check(isBrandLogoUrl))))

// 字段缺省表示保留当前值,null 表示清除。
const brandingPatchBodySchema = v.object({
  primaryColor: brandField(isBrandColor),
  backgroundColor: brandField(isBrandColor),
  accentColor: brandField(isBrandColor),
  borderRadius: v.optional(v.nullable(v.picklist(BRAND_RADII))),
  fontFamily: brandField(isBrandFontFamily),
  logoUrl: brandLogoField,
  logoDarkUrl: brandLogoField,
  colorScheme: v.optional(v.nullable(v.picklist(BRAND_COLOR_SCHEMES))),
})

const logoQuerySchema = v.object({
  variant: v.optional(v.picklist(['light', 'dark']), 'light'),
})

type BrandingPatch = v.InferOutput<typeof brandingPatchBodySchema>

export type BrandContrastCheck = {
  key: 'button_text' | 'link' | 'focus_ring'
  ratio: number
  minimum: number
}

// 与 Hosted UI 渲染同源(deriveAccentPalette):按钮白字对原始强调色、浅色下派生链接色对白底、
// 深色下派生焦点环对深色底。焦点环属非文字控件,按 WCAG 1.4.11 取 3:1。
export function brandContrastChecks(accent: string): BrandContrastCheck[] {
  const rgb = parseHexColor(accent)
  const light = deriveAccentPalette(accent, 'light')
  const dark = deriveAccentPalette(accent, 'dark')
  const link = light ? parseHexColor(light.accent) : null
  const ring = dark ? parseHexColor(dark.accent) : null
  if (!rgb || !link || !ring) return []
  return [
    { key: 'button_text', ratio: contrastRatio(WHITE, rgb), minimum: TEXT_CONTRAST },
    { key: 'link', ratio: contrastRatio(link, WHITE), minimum: TEXT_CONTRAST },
    { key: 'focus_ring', ratio: contrastRatio(ring, DARK_SURFACE), minimum: CONTROL_CONTRAST },
  ]
}

type BrandingState = {
  published: OrgBranding
  draft: OrgBranding | null
  draftUpdatedAt: number | null
  publishedAt: number | null
  publishedBy: string | null
}

function privateMetadataOf(org: OrgRow): Record<string, unknown> {
  const value = org.privateMetadata
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function brandingKvKey(tenantId: string, orgId: string): string {
  return `brand:${tenantId}:${orgId}`
}

// v0.0.8 及更早版本只把品牌写在 CACHE KV、logo 只写在 organizations.logo_url;
// D1 尚无品牌记录时合并这两处旧值,下一次发布迁入 D1。
async function readPublished(c: Context<XidHonoEnv>, org: OrgRow): Promise<OrgBranding> {
  const metadata = privateMetadataOf(org)
  if (metadata['branding'] !== undefined) return normalizeOrgBranding(metadata['branding'])
  const legacy = await readLegacyKvBranding(c, org)
  if (legacy.logoUrl === null && org.logoUrl && isBrandLogoUrl(org.logoUrl)) {
    return { ...legacy, logoUrl: org.logoUrl }
  }
  return legacy
}

async function readLegacyKvBranding(c: Context<XidHonoEnv>, org: OrgRow): Promise<OrgBranding> {
  const legacy = await c.env.CACHE.get(brandingKvKey(org.tenantId, org.id))
  if (!legacy) return DEFAULT_ORG_BRANDING
  try {
    return normalizeOrgBranding(JSON.parse(legacy))
  } catch {
    return DEFAULT_ORG_BRANDING
  }
}

async function readState(c: Context<XidHonoEnv>, org: OrgRow): Promise<BrandingState> {
  const metadata = privateMetadataOf(org)
  const rawDraft = metadata['brandingDraft']
  return {
    published: await readPublished(c, org),
    draft: rawDraft === undefined || rawDraft === null ? null : normalizeOrgBranding(rawDraft),
    draftUpdatedAt: numberOrNull(metadata['brandingDraftUpdatedAt']),
    publishedAt: numberOrNull(metadata['brandingPublishedAt']),
    publishedBy:
      typeof metadata['brandingPublishedBy'] === 'string' ? metadata['brandingPublishedBy'] : null,
  }
}

async function toEnvelope(c: Context<XidHonoEnv>, state: BrandingState) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const actors = state.publishedBy
    ? await loadActorDisplays(db, [state.publishedBy])
    : new Map<string, ActorDisplay>()
  return {
    published: state.published,
    draft: state.draft,
    draftUpdatedAt: toIso(state.draftUpdatedAt),
    publishedAt: toIso(state.publishedAt),
    publishedBy: state.publishedBy ? (actors.get(state.publishedBy) ?? null) : null,
    hasUnpublishedChanges: state.draft !== null && !sameOrgBranding(state.draft, state.published),
    signInHost: new URL(hostedAuthOrigin(c)).host,
  }
}

function mergeBranding(current: OrgBranding, patch: BrandingPatch): OrgBranding {
  const next = { ...current }
  for (const field of ORG_BRANDING_FIELDS) {
    const value = patch[field]
    if (value !== undefined) Object.assign(next, { [field]: value })
  }
  return next
}

async function writeMetadata(
  c: Context<XidHonoEnv>,
  org: OrgRow,
  patch: Record<string, unknown>,
  logoUrl?: string | null,
): Promise<OrgRow> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const updated = await db.organizations.update(
    {
      privateMetadata: { ...privateMetadataOf(org), ...patch },
      ...(logoUrl !== undefined ? { logoUrl } : {}),
    },
    eq(schema.organizations.id, org.id),
  )
  return updated[0] ?? org
}

// 草稿与已发布一致时清掉草稿,页面回到「Live」状态。
async function saveDraft(c: Context<XidHonoEnv>, org: OrgRow, draft: OrgBranding): Promise<OrgRow> {
  const published = await readPublished(c, org)
  if (sameOrgBranding(draft, published)) {
    return writeMetadata(c, org, { brandingDraft: null, brandingDraftUpdatedAt: null })
  }
  return writeMetadata(c, org, { brandingDraft: draft, brandingDraftUpdatedAt: Date.now() })
}

function auditBranding(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: { orgId: string; action: string; fields: readonly string[] },
): void {
  auditOrgMutation(c, auth, {
    action: input.action,
    orgId: input.orgId,
    targetType: 'organization',
    targetId: input.orgId,
    details: { fields: input.fields },
  })
}

function changedFields(before: OrgBranding, after: OrgBranding): string[] {
  return ORG_BRANDING_FIELDS.filter((field) => before[field] !== after[field])
}

// GET /v1/organizations/:id/branding
app.get('/:id/branding', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'branding:read')
  const org = await requireOrg(c, id)
  return c.json(await toEnvelope(c, await readState(c, org)))
})

// PATCH /v1/organizations/:id/branding  只写草稿,Hosted UI 不受影响。
app.patch('/:id/branding', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'branding:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(brandingPatchBodySchema, json.value)
  const org = await requireOrg(c, id)
  const state = await readState(c, org)
  const next = mergeBranding(state.draft ?? state.published, body)
  const saved = await saveDraft(c, org, next)
  auditBranding(c, auth, {
    orgId: id,
    action: 'organization.branding.draft_saved',
    fields: ORG_BRANDING_FIELDS.filter((field) => body[field] !== undefined),
  })
  return c.json(await toEnvelope(c, await readState(c, saved)))
})

// POST /v1/organizations/:id/branding/publish
app.post('/:id/branding/publish', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'branding:write')
  const org = await requireOrg(c, id)
  const state = await readState(c, org)
  if (!state.draft) throw new AppError('conflict', { httpStatus: 409 })

  const accent = brandAccentOf(state.draft)
  const failing = accent
    ? brandContrastChecks(accent).some((check) => check.ratio < check.minimum)
    : false
  if (failing) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'accentColor' } })
  }

  const published = await writeMetadata(
    c,
    org,
    {
      branding: hasCustomBranding(state.draft) ? state.draft : null,
      brandingDraft: null,
      brandingDraftUpdatedAt: null,
      brandingPublishedAt: Date.now(),
      brandingPublishedBy: auditActorId(auth),
    },
    state.draft.logoUrl,
  )
  await c.env.CACHE.delete(brandingKvKey(org.tenantId, org.id))
  auditBranding(c, auth, {
    orgId: id,
    action: 'organization.branding.published',
    fields: changedFields(state.published, state.draft),
  })
  return c.json(await toEnvelope(c, await readState(c, published)))
})

// PUT /v1/organizations/:id/logo?variant=light|dark  multipart/form-data (field: file),写入草稿。
app.put('/:id/logo', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'organizations:write')
  const { variant } = validateQuery(logoQuerySchema, c.req.query())
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
  const field = variant === 'dark' ? 'logoDarkUrl' : 'logoUrl'
  const state = await readState(c, org)
  const saved = await saveDraft(c, org, { ...(state.draft ?? state.published), [field]: logoUrl })
  auditBranding(c, auth, {
    orgId: id,
    action: 'organization.branding.draft_saved',
    fields: [field],
  })
  return c.json({
    logo_url: logoUrl,
    variant,
    organization: toOrganizationResponse(saved),
    branding: await toEnvelope(c, await readState(c, saved)),
  })
})

export function registerOrgBrandingRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
