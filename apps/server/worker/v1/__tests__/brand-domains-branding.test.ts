// 品牌草稿与发布:草稿不影响已发布版本,发布前按 WCAG 校验强调色。真实 sqlite + 迁移链。

import { describe, expect, it, vi } from 'vitest'
import { normalizeOrgBranding } from '@xid-kit/types'
import { brandContrastChecks, registerOrgBrandingRoutes } from '../org-branding'
import {
  buildApp,
  envOf,
  json,
  makeDb,
  seedApiKey,
  seedMembership,
  seedOrg,
  seedUser,
  sessionFor,
  tenantDb,
} from './console-fixtures'

const BASE = 'https://acme.xid.dev/v1/organizations/t_a'

type Envelope = {
  published: Record<string, unknown>
  draft: Record<string, unknown> | null
  draftUpdatedAt: string | null
  publishedAt: string | null
  publishedBy: { kind: string; id: string; displayName: string | null } | null
  hasUnpublishedChanges: boolean
}

async function setup() {
  const d1 = makeDb()
  await seedOrg(d1, { id: 't_a', name: 'Northwind Logistics' })
  const token = await seedApiKey(d1, {
    id: 'ak_brand',
    scopes: ['branding:read', 'branding:write', 'organizations:write'],
  })
  const kvDelete = vi.fn().mockResolvedValue(undefined)
  const stored: string[] = []
  const env = {
    ...envOf(d1),
    CACHE: { get: vi.fn().mockResolvedValue(null), delete: kvDelete },
    STORAGE: {
      put: async (key: string) => {
        stored.push(key)
      },
    },
  } as unknown as ReturnType<typeof envOf>
  const app = buildApp(registerOrgBrandingRoutes)
  const headers = { Authorization: `Bearer ${token}` }
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`${BASE}${path}`, { ...init, headers: { ...headers, ...init.headers } }, env)
  const patch = (body: Record<string, unknown>) =>
    request('/branding', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  const publish = () => request('/branding/publish', { method: 'POST' })
  const readOrg = async () =>
    (await tenantDb(d1).organizations.findMany()).find((org) => org.id === 't_a')!
  return { d1, env, app, request, patch, publish, readOrg, kvDelete, stored }
}

describe('brandContrastChecks', () => {
  it('fails white button text on a light accent and passes the darker suggestion', () => {
    const light = brandContrastChecks('#E8B33A')
    const dark = brandContrastChecks('#8C6400')

    expect(light.find((check) => check.key === 'button_text')!.ratio).toBeLessThan(4.5)
    expect(dark.every((check) => check.ratio >= check.minimum)).toBe(true)
  })

  it('holds the focus ring to the 3:1 non-text minimum', () => {
    const checks = brandContrastChecks('#8C6400')

    expect(checks.map((check) => [check.key, check.minimum])).toEqual([
      ['button_text', 4.5],
      ['link', 4.5],
      ['focus_ring', 3],
    ])
  })
})

describe('branding draft and publish', () => {
  it('PATCH saves a draft without changing the published branding', async () => {
    const { patch, request, readOrg } = await setup()

    const saved = await patch({
      accentColor: '#8C6400',
      borderRadius: 'medium',
      colorScheme: 'system',
    })
    const read = await json<Envelope>(await request('/branding'))

    expect(saved.status).toBe(200)
    expect(read.hasUnpublishedChanges).toBe(true)
    expect(read.draft).toMatchObject({
      accentColor: '#8C6400',
      borderRadius: 'medium',
      colorScheme: 'system',
    })
    expect(read.published).toMatchObject({ accentColor: null, borderRadius: null })
    expect(read.draftUpdatedAt).not.toBeNull()
    expect(
      normalizeOrgBranding((await readOrg()).privateMetadata['branding']).accentColor,
    ).toBeNull()
  })

  it('rejects publishing an accent below 4.5:1 and keeps the live version', async () => {
    const { patch, publish, request } = await setup()
    await patch({ accentColor: '#E8B33A' })

    const res = await publish()
    const read = await json<Envelope>(await request('/branding'))

    expect(res.status).toBe(422)
    expect(await json(res)).toMatchObject({
      code: 'validation_failed',
      meta: { paramName: 'accentColor' },
    })
    expect(read.published.accentColor).toBeNull()
    expect(read.hasUnpublishedChanges).toBe(true)
  })

  it('publishes a passing draft, clears it, syncs the consent logo and invalidates the KV cache', async () => {
    const { patch, publish, readOrg, kvDelete, env } = await setup()
    await patch({ accentColor: '#8C6400', logoUrl: 'https://cdn.example.com/logo.svg' })

    const res = await publish()
    const body = await json<Envelope>(res)
    const org = await readOrg()

    expect(res.status).toBe(200)
    expect(body.published).toMatchObject({
      accentColor: '#8C6400',
      logoUrl: 'https://cdn.example.com/logo.svg',
    })
    expect(body.draft).toBeNull()
    expect(body.hasUnpublishedChanges).toBe(false)
    expect(body.publishedBy).toEqual({ kind: 'api_key', id: 'ak_brand', displayName: 'test' })
    expect(org.logoUrl).toBe('https://cdn.example.com/logo.svg')
    expect(kvDelete).toHaveBeenCalledWith('brand:t_a:t_a')
    const actions = (
      env as unknown as { auditSend: ReturnType<typeof vi.fn> }
    ).auditSend.mock.calls.map((call) => (call[0] as { action: string }).action)
    expect(actions).toEqual([
      'organization.branding.draft_saved',
      'organization.branding.published',
    ])
  })

  it('returns 409 when there is no draft to publish', async () => {
    const { publish } = await setup()

    expect((await publish()).status).toBe(409)
  })

  it('drops the draft when edits return to the published values', async () => {
    const { patch, publish } = await setup()
    await patch({ accentColor: '#8C6400' })
    await publish()

    const res = await patch({ accentColor: '#8C6400' })

    expect((await json<Envelope>(res)).draft).toBeNull()
  })

  it('rejects legacy CSS radius lengths and unknown color schemes', async () => {
    const { patch } = await setup()

    const radius = await patch({ borderRadius: '8px' })
    const scheme = await patch({ colorScheme: 'sepia' })

    expect(radius.status).toBe(422)
    expect(scheme.status).toBe(422)
  })

  it('uploads the dark logo into the draft for an organization owner session', async () => {
    const { d1, env, stored } = await setup()
    await seedUser(d1, { id: 'u_owner', email: 'dana@northwind.com', firstName: 'Dana' })
    await seedMembership(d1, { id: 'm_owner', userId: 'u_owner', orgId: 't_a', role: 'owner' })
    const app = buildApp(registerOrgBrandingRoutes, { session: sessionFor('u_owner') })
    const form = new FormData()
    form.set('file', new File(['svg'], 'logo.svg', { type: 'image/svg+xml' }))

    const res = await app.request(`${BASE}/logo?variant=dark`, { method: 'PUT', body: form }, env)
    const body = await json<{ variant: string; logo_url: string; branding: Envelope }>(res)

    expect(res.status).toBe(200)
    expect(body.variant).toBe('dark')
    expect(body.branding.draft).toMatchObject({ logoDarkUrl: body.logo_url, logoUrl: null })
    expect(body.branding.published.logoDarkUrl).toBeNull()
    expect(stored).toHaveLength(1)
  })

  it('rejects an unknown logo variant', async () => {
    const { request } = await setup()
    const form = new FormData()
    form.set('file', new File(['png'], 'logo.png', { type: 'image/png' }))

    const res = await request('/logo?variant=sepia', { method: 'PUT', body: form })

    expect(res.status).toBe(422)
  })
})
