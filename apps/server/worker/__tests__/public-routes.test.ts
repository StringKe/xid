import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOSTED_AUTH_PROFILE_FIELDS } from '@xid-kit/types'
import type { SigningKeyMaterial } from '@xid-kit/types'
import { generateTenantSigningKey } from '@xid-kit/crypto'
import { PUBLIC_DOC_SLUGS } from '../../public-docs'
import type { XidHonoEnv } from '../lib/types'
import { renderDocsSeoFallback } from '../public-assets'
import { registerHostedAuthConfigRoutes } from '../auth/config'
import { registerOidcRoutes } from '../oidc'
import {
  buildTestTenant,
  makeApp,
  makeApp as makeOidcApp,
  makeEnv as makeOidcEnv,
} from '../oidc/__tests__/helpers'
import { tenantMiddleware } from '../middleware/tenant'
import { sessionMiddleware } from '../middleware/session'
import { TENANT_ROUTE_PATTERNS } from '../tenant-routes'
import { registerPublicAssetRoutes } from '../public-assets'

type RouteTable = Record<string, Record<string, unknown>[]>

const UNMATCHED_PROTOCOL_PREFIXES = ['/auth/', '/sso/', '/scim/', '/v1/'] as const

const UNMATCHED_PROTOCOL_PATHS = new Set(['/frontchannel_logout'])

function asUnknown<T>(v: unknown): T {
  return v as T
}

function projectionColumns(sql: string): string[] {
  const head = /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return head.split(',').flatMap((part) => {
    const quoted = [...part.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
    const column = quoted.at(-1)
    return column ? [column] : []
  })
}

function rowToRaw(sql: string, row: Record<string, unknown>): unknown[] {
  return projectionColumns(sql).map((c) => row[c] ?? null)
}

function tableForSql(sql: string): string {
  const l = sql.toLowerCase()
  if (l.includes('user_emails')) return 'user_emails'
  if (l.includes('user_phones')) return 'user_phones'
  if (l.includes('users')) return 'users'
  if (l.includes('instance_signing_keys')) return 'instance_signing_keys'
  if (l.includes('tenant_signing_keys')) return 'tenant_signing_keys'
  if (l.includes('org_policies')) return 'org_policies'
  if (l.includes('organizations')) return 'organizations'
  return 'instances'
}

function makeRouteD1(tables: RouteTable): D1Database {
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => matchRows(tables, sql, bound).map((r) => rowToRaw(sql, r)),
      all: async () => ({ results: matchRows(tables, sql, bound), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

function matchRows(tables: RouteTable, sql: string, params: unknown[]): Record<string, unknown>[] {
  const lower = sql.toLowerCase()
  if (lower.includes('from "user_emails"') && lower.includes('join')) {
    const email = params.find((v): v is string => typeof v === 'string' && v.includes('@'))
    const users = tables['users'] ?? []
    return (tables['user_emails'] ?? [])
      .filter((row) => row['email'] === email)
      .filter((row) =>
        users.some(
          (user) =>
            user['id'] === row['user_id'] &&
            user['status'] === 'active' &&
            user['deleted_at'] == null,
        ),
      )
      .map((row) => ({ tenant_id: row['tenant_id'], tenantId: row['tenant_id'] }))
  }
  if (lower.includes('from "users"') && lower.includes('username')) {
    const value = params.find((v): v is string => typeof v === 'string' && v !== 'active')
    return (tables['users'] ?? [])
      .filter(
        (row) =>
          row['username'] === value && row['status'] === 'active' && row['deleted_at'] == null,
      )
      .map((row) => ({ tenant_id: row['tenant_id'], tenantId: row['tenant_id'] }))
  }
  if (lower.includes('from "organizations"') && lower.includes('"organizations"."id"')) {
    const rows = tables['organizations'] ?? []
    const ids = new Set(
      params.filter(
        (value): value is string =>
          typeof value === 'string' && rows.some((row) => row['id'] === value),
      ),
    )
    if (ids.size > 0) {
      return rows.filter((row) => ids.has(String(row['id'])) && row['status'] === 'active')
    }
  }
  const rows = tables[tableForSql(sql)] ?? []
  const sp = params.filter((v): v is string => typeof v === 'string')
  if (sp.length === 0) return rows
  return rows.filter((r) => sp.every((v) => Object.values(r).includes(v)))
}

function makeAssets(): Fetcher {
  return asUnknown<Fetcher>({
    fetch: async () =>
      new Response(
        '<!doctype html><main data-seo-fallback><h1>XID</h1></main><div id="root"></div>',
        {
          status: 200,
          headers: { 'content-type': 'text/html;charset=UTF-8', etag: '"asset"' },
        },
      ),
  })
}

function makeKv(): KVNamespace {
  return asUnknown<KVNamespace>({
    get: async () => null,
    put: async () => undefined,
  })
}

function makeRouteSplitApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.get('/v1/health', (c) => c.json({ ok: true }))
  app.get('/v1/edge', async (c) => {
    const { buildEdgeProbePayload } = await import('../lib/edge-probe')
    return c.json(await buildEdgeProbePayload(c.req.raw.cf))
  })
  for (const pattern of TENANT_ROUTE_PATTERNS) {
    app.use(pattern, async (c, next) => {
      c.set('locale', 'en')
      await next()
    })
    app.use(pattern, tenantMiddleware)
    app.use(pattern, sessionMiddleware)
  }
  registerHostedAuthConfigRoutes(app)
  app.all('*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname
    if (
      UNMATCHED_PROTOCOL_PATHS.has(pathname) ||
      UNMATCHED_PROTOCOL_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ) {
      return c.json({ code: 'not_found', message: 'Not found.' }, 404)
    }
    await next()
  })
  registerPublicAssetRoutes(app)
  return app
}

async function makeRouteEnv(): Promise<Env> {
  const kekRaw = crypto.getRandomValues(new Uint8Array(32))
  const { material } = await generateTenantSigningKey({
    kid: 'kid-default',
    kekRaw,
    kekVersion: 1,
    alg: 'ES256',
    status: 'active',
  })
  return asUnknown<Env>({
    DB: makeRouteD1(routeTables(material)),
    CACHE: makeKv(),
    ASSETS: makeAssets(),
    GOOGLE_CLIENT_SECRET: 'google-secret',
  })
}

function routeTables(material: SigningKeyMaterial): RouteTable {
  const now = Date.now()
  const defaultTenantId = 'org_default'
  const teamTenantId = 'org_team'
  const hostedAuth = {
    password: { enabled: false, allowLogin: false, allowUserCreation: false },
    magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
    emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
    whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
  }
  const usernameHostedAuth = {
    ...hostedAuth,
    identifierMode: 'username',
    magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
    emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
    password: { enabled: true, allowLogin: true, allowUserCreation: false },
  }
  return {
    instances: [
      {
        id: 'inst_1',
        name: 'XID',
        primary_domain: 'xid.dev',
        mode: 'multi_tenant',
        default_locale: 'en',
        data_residency: 'us',
        mfa_policy: 'optional',
        password_policy: JSON.stringify({}),
        session_policy: JSON.stringify({}),
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    ],
    organizations: [
      {
        id: defaultTenantId,
        tenant_id: defaultTenantId,
        instance_id: 'inst_1',
        parent_org_id: null,
        slug: 'default',
        name: 'Default Organization',
        private_metadata: JSON.stringify({ hostedAuth }),
        public_metadata: JSON.stringify({}),
        seat_limit: null,
        seat_used: 0,
        enrollment_mode: 'invite_required',
        allow_org_self_service: 1,
        status: 'active',
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: teamTenantId,
        tenant_id: teamTenantId,
        instance_id: 'inst_1',
        parent_org_id: null,
        slug: 'team',
        name: 'Team Tenant',
        private_metadata: JSON.stringify({ hostedAuth: usernameHostedAuth }),
        public_metadata: JSON.stringify({}),
        seat_limit: null,
        seat_used: 0,
        enrollment_mode: 'invite_required',
        allow_org_self_service: 1,
        status: 'active',
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    org_policies: [],
    users: [
      {
        id: 'user_admin',
        tenant_id: defaultTenantId,
        status: 'active',
        deleted_at: null,
      },
      {
        id: 'user_team',
        tenant_id: teamTenantId,
        status: 'active',
        deleted_at: null,
        username: 'teamuser',
      },
      {
        id: 'user_admin_shared',
        tenant_id: defaultTenantId,
        status: 'active',
        deleted_at: null,
        username: 'shared',
      },
      {
        id: 'user_team_shared',
        tenant_id: teamTenantId,
        status: 'active',
        deleted_at: null,
        username: 'shared',
      },
    ],
    user_emails: [
      {
        id: 'email_admin',
        tenant_id: defaultTenantId,
        user_id: 'user_admin',
        email: 'admin@example.test',
        verified: 1,
        verification_status: 'verified',
        is_primary: 1,
      },
    ],
    instance_signing_keys: [
      {
        id: 'isk_1',
        instance_id: 'inst_1',
        kid: material.kid,
        alg: material.alg,
        status: material.status,
        public_key_jwk: JSON.stringify(material.publicKeyJwk),
        private_key_iv: material.encryptedPrivateKey.iv,
        private_key_ciphertext: material.encryptedPrivateKey.ciphertext,
        private_key_tag: material.encryptedPrivateKey.tag,
        kek_version: material.encryptedPrivateKey.kekVersion,
        not_before: now,
        not_after: null,
        retire_after: null,
        created_at: now,
        updated_at: now,
      },
    ],
  }
}

describe('GET /auth/config', () => {
  it('returns only enabled and configured social providers', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(
      {
        ...ctx,
        policy: {
          hostedAuth: {
            identifierMode: 'email',
            requireVerifiedEmail: true,
            allowedEmailDomains: ['example.com'],
            blockedEmailDomains: [],
            forceSso: false,
            allowUserCreation: true,
            allowExistingUserLogin: true,
            profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
            password: { enabled: false, allowLogin: false, allowUserCreation: false },
            magicLink: { enabled: true, allowLogin: true, allowUserCreation: false },
            emailOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
            enterpriseSso: {
              enabled: false,
              allowLogin: false,
              allowJitUserCreation: false,
              domainDiscovery: false,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
          socialProviders: {
            google: {
              enabled: true,
              allowLogin: true,
              allowUserCreation: false,
              requireVerifiedEmail: true,
              allowedEmailDomains: ['example.com'],
              blockedEmailDomains: [],
              authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenEndpoint: 'https://oauth2.googleapis.com/token',
              clientId: 'google-client',
              clientSecretRef: 'GOOGLE_CLIENT_SECRET',
              issuer: 'https://accounts.google.com',
              jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
              scopes: ['openid', 'email', 'profile'],
              usesPkce: true,
            },
            github: {
              enabled: false,
              allowLogin: true,
              allowUserCreation: false,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
              authorizationEndpoint: 'https://github.com/login/oauth/authorize',
              tokenEndpoint: 'https://github.com/login/oauth/access_token',
              clientId: 'github-client',
              scopes: ['read:user'],
              usesPkce: true,
            },
          },
          deliveryChannels: {
            whatsapp: {
              provider: 'meta',
              enabled: true,
              secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
            },
            sms: {
              provider: 'twilio',
              enabled: true,
              secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
              from: '+15550000000',
            },
          },
        },
      },
      registerHostedAuthConfigRoutes,
    )

    const res = await app.request(
      'https://xid.dev/auth/config',
      {},
      asUnknown<Env>({ GOOGLE_CLIENT_SECRET: 'google-secret' }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      blockedEmailDomains: string[]
      profileFields: Record<string, string>
      methods: { password: { enabled: boolean } }
      socialProviders: unknown[]
    }
    expect(body.blockedEmailDomains).toEqual([])
    expect(body.profileFields).toMatchObject({ email: 'required', username: 'hidden' })
    expect(body.methods.password.enabled).toBe(false)
    expect(body.socialProviders).toHaveLength(1)
    expect(body.socialProviders[0]).toMatchObject({ provider: 'google' })
  })

  it('hides enabled social providers when client secret credentials are missing', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(
      {
        ...ctx,
        policy: {
          hostedAuth: {
            identifierMode: 'email',
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
            forceSso: false,
            allowUserCreation: true,
            allowExistingUserLogin: true,
            profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
            password: { enabled: false, allowLogin: false, allowUserCreation: false },
            magicLink: { enabled: true, allowLogin: true, allowUserCreation: false },
            emailOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
            enterpriseSso: {
              enabled: false,
              allowLogin: false,
              allowJitUserCreation: false,
              domainDiscovery: false,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
          socialProviders: {
            google: {
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
              authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenEndpoint: 'https://oauth2.googleapis.com/token',
              clientId: 'google-client',
              scopes: ['openid', 'email', 'profile'],
              usesPkce: true,
            },
            github: {
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
              authorizationEndpoint: 'https://github.com/login/oauth/authorize',
              tokenEndpoint: 'https://github.com/login/oauth/access_token',
              clientId: 'github-client',
              clientSecretRef: 'MISSING_GITHUB_SECRET',
              scopes: ['read:user'],
              usesPkce: true,
            },
          },
        },
      },
      registerHostedAuthConfigRoutes,
    )

    const res = await app.request('https://xid.dev/auth/config', {}, asUnknown<Env>({}))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { socialProviders: unknown[] }
    expect(body.socialProviders).toHaveLength(0)
  })

  it('hides social providers when force SSO is enabled', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(
      {
        ...ctx,
        policy: {
          hostedAuth: {
            identifierMode: 'email',
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
            forceSso: true,
            allowUserCreation: true,
            allowExistingUserLogin: true,
            profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
            password: { enabled: true, allowLogin: true, allowUserCreation: true },
            magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
            emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
            whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            passkey: { enabled: true, allowLogin: true, allowUserCreation: false },
            enterpriseSso: {
              enabled: true,
              allowLogin: true,
              allowJitUserCreation: true,
              domainDiscovery: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
          socialProviders: {
            google: {
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
              authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenEndpoint: 'https://oauth2.googleapis.com/token',
              clientId: 'google-client',
              clientSecretRef: 'GOOGLE_CLIENT_SECRET',
              scopes: ['openid', 'email', 'profile'],
              usesPkce: true,
            },
          },
        },
      },
      registerHostedAuthConfigRoutes,
    )

    const res = await app.request(
      'https://xid.dev/auth/config',
      {},
      asUnknown<Env>({ GOOGLE_CLIENT_SECRET: 'google-secret' }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      forceSso: boolean
      socialProviders: unknown[]
    }
    expect(body.forceSso).toBe(true)
    expect(body.socialProviders).toHaveLength(0)
  })

  it('hides SMS OTP when no SMS provider is configured even if organization policy enables it', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(
      {
        ...ctx,
        policy: {
          hostedAuth: {
            identifierMode: 'phone',
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
            forceSso: false,
            allowUserCreation: true,
            allowExistingUserLogin: true,
            profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
            password: { enabled: false, allowLogin: false, allowUserCreation: false },
            magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
            emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            whatsappOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            smsOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
            enterpriseSso: {
              enabled: false,
              allowLogin: false,
              allowJitUserCreation: false,
              domainDiscovery: false,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
          deliveryChannels: {
            whatsapp: {
              provider: 'meta',
              enabled: true,
              secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
            },
            sms: {
              provider: 'twilio',
              enabled: true,
              secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
            },
          },
        },
      },
      registerHostedAuthConfigRoutes,
    )

    const res = await app.request('https://xid.dev/auth/config', {}, asUnknown<Env>({}))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      methods: { whatsappOtp: { enabled: boolean }; smsOtp: { enabled: boolean } }
    }
    expect(body.methods.whatsappOtp.enabled).toBe(false)
    expect(body.methods.smsOtp.enabled).toBe(false)
  })

  it('shows WhatsApp and SMS OTP when organization policy enables them and providers are configured', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(
      {
        ...ctx,
        policy: {
          hostedAuth: {
            identifierMode: 'phone',
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
            forceSso: false,
            allowUserCreation: true,
            allowExistingUserLogin: true,
            profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
            password: { enabled: false, allowLogin: false, allowUserCreation: false },
            magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
            emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            whatsappOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            smsOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
            enterpriseSso: {
              enabled: false,
              allowLogin: false,
              allowJitUserCreation: false,
              domainDiscovery: false,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
          deliveryChannels: {
            whatsapp: {
              provider: 'meta',
              enabled: true,
              secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
            },
            sms: {
              provider: 'twilio',
              enabled: true,
              secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
            },
          },
        },
      },
      registerHostedAuthConfigRoutes,
    )

    const res = await app.request(
      'https://xid.dev/auth/config',
      {},
      asUnknown<Env>({
        WHATSAPP_META_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_META_ACCESS_TOKEN: 'meta-token',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
        SMS_FROM: '+15550000000',
      }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      methods: { whatsappOtp: { enabled: boolean }; smsOtp: { enabled: boolean } }
    }
    expect(body.methods.whatsappOtp.enabled).toBe(true)
    expect(body.methods.smsOtp.enabled).toBe(true)
  })

  it('hides SMS OTP when Twilio secrets exist but no sender is configured', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeApp(
      {
        ...ctx,
        policy: {
          hostedAuth: {
            identifierMode: 'phone',
            requireVerifiedEmail: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
            forceSso: false,
            allowUserCreation: true,
            allowExistingUserLogin: true,
            profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
            password: { enabled: false, allowLogin: false, allowUserCreation: false },
            magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
            emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            smsOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
            enterpriseSso: {
              enabled: false,
              allowLogin: false,
              allowJitUserCreation: false,
              domainDiscovery: false,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
          deliveryChannels: {
            sms: {
              provider: 'twilio',
              enabled: true,
              secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
            },
          },
        },
      },
      registerHostedAuthConfigRoutes,
    )

    const res = await app.request(
      'https://xid.dev/auth/config',
      {},
      asUnknown<Env>({
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
      }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { methods: { smsOtp: { enabled: boolean } } }
    expect(body.methods.smsOtp.enabled).toBe(false)
  })
})

describe('createApp public and organization route split', () => {
  it('serves SPA sign-in through ASSETS without organization middleware', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request('https://xid.dev/sign-in', {}, env)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root"></div>')
  })

  it('renders SEO fallback text for every published docs route', () => {
    for (const slug of PUBLIC_DOC_SLUGS) {
      const path = slug === 'getting-started' ? '/docs' : `/docs/${slug}`
      const fallback = renderDocsSeoFallback(path)

      expect(fallback, path).toContain('<main data-seo-fallback>')
      expect(fallback, path).toContain('XID')
      expect(fallback, path).toContain('https://xid.dev/docs')
      expect(fallback, path).not.toContain('docs/design')
      expect(fallback, path).not.toContain('Open docs')
    }
  })

  it('serves enterprise SSO docs with route-specific SEO fallback text', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request('https://xid.dev/docs/enterprise-sso', {}, env)
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('Permissions-Policy')).toBe('tools=(self)')
    expect(res.headers.get('Origin-Agent-Cluster')).toBe('?1')
    expect(res.headers.has('etag')).toBe(false)
    expect(body).toContain('<h1>Enterprise SSO</h1>')
    expect(body).toContain('Legacy protocol boundaries')
    expect(body).toContain('Kerberos termination are not supported.')
    expect(body).toContain('https://xid.dev/docs/enterprise-sso')
    expect(body).not.toContain('production-supported')
    expect(body).not.toContain('public-supported')
  })

  it('resolves root Hosted Auth config through the instance entry default organization', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request(
      'https://xid.dev/auth/config',
      { headers: { host: 'xid.dev' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      resolution: { status: string }
      methods: { magicLink: { enabled: boolean } }
      socialProviders: unknown[]
    }
    expect(body.resolution.status).toBe('ready')
    expect(body.methods.magicLink.enabled).toBe(true)
    expect(body.socialProviders).toEqual([])
  })

  it('resolves root Hosted Auth config with super admin email login_hint to default org policy', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request(
      'https://xid.dev/auth/config?login_hint=admin%40example.test',
      { headers: { host: 'xid.dev' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      methods: { password: { enabled: boolean }; magicLink: { enabled: boolean } }
    }
    expect(body.methods.password.enabled).toBe(false)
    expect(body.methods.magicLink.enabled).toBe(true)
  })

  it('resolves root Hosted Auth config with username login_hint to matching organization policy', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request(
      'https://xid.dev/auth/config?login_hint=teamuser',
      { headers: { host: 'xid.dev' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      identifierMode: string
      methods: { password: { enabled: boolean }; magicLink: { enabled: boolean } }
    }
    expect(body.identifierMode).toBe('username')
    expect(body.methods.password.enabled).toBe(true)
    expect(body.methods.magicLink.enabled).toBe(false)
  })

  it('returns ambiguous root Hosted Auth config with organization choices for shared login_hint', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request(
      'https://xid.dev/auth/config?login_hint=shared',
      { headers: { host: 'xid.dev' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      resolution: {
        status: string
        matchedBy: string
        matches: Array<{ organizationId: string; slug: string; name: string; issuer: string }>
      }
      methods: { magicLink: { enabled: boolean }; password: { enabled: boolean } }
    }
    expect(body.resolution.status).toBe('ambiguous')
    expect(body.resolution.matchedBy).toBe('username')
    expect(body.resolution.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: 'org_default',
          slug: 'default',
          name: 'Default Organization',
          issuer: 'https://xid.dev',
        }),
        expect.objectContaining({
          organizationId: 'org_team',
          slug: 'team',
          name: 'Team Tenant',
          issuer: 'https://xid.dev',
        }),
      ]),
    )
    expect(body.methods.magicLink.enabled).toBe(false)
    expect(body.methods.password.enabled).toBe(false)
  })

  it('resolves root Hosted Auth config with organization_id resolver hint to selected organization policy', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request(
      'https://xid.dev/auth/config?organization_id=org_default&login_hint=shared',
      { headers: { host: 'xid.dev' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      resolution: { status: string }
      methods: { password: { enabled: boolean }; magicLink: { enabled: boolean } }
    }
    expect(body.resolution.status).toBe('ready')
    expect(body.methods.password.enabled).toBe(false)
    expect(body.methods.magicLink.enabled).toBe(true)
  })

  it('keeps default subdomain Hosted Auth config on the default tenant', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request(
      'https://default.xid.dev/auth/config',
      { headers: { host: 'default.xid.dev' } },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { methods: { emailOtp: { enabled: boolean } } }
    expect(body.methods.emailOtp.enabled).toBe(true)
  })

  it('serves public docs paths through the public SPA asset entry', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request('https://xid.dev/docs/scim', {}, env)
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('<div id="root"></div>')
  })

  it('blocks repository docs paths from the public XID docs namespace', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    for (const path of ['/docs/design', '/docs/goal', '/docs/verification']) {
      const res = await app.request(`https://xid.dev${path}`, {}, env)
      const html = await res.text()

      expect(res.status).toBe(404)
      expect(res.headers.get('x-xid-docs-route-status')).toBe('blocked-non-public-docs-path')
      expect(html).toContain('published XID developer docs')
    }
  })

  it('blocks same-name repository docs markdown paths from the public docs namespace', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    const res = await app.request('https://xid.dev/docs/deployment', {}, env)
    const html = await res.text()

    expect(res.status).toBe(404)
    expect(res.headers.get('x-xid-docs-route-status')).toBe('blocked-non-public-docs-path')
    expect(html).toContain('published XID developer docs')
  })

  it('does not serve SPA fallback for unknown protocol paths', async () => {
    const env = await makeRouteEnv()
    const app = makeRouteSplitApp()

    for (const path of ['/auth/social/github', '/frontchannel_logout']) {
      const res = await app.request(`https://xid.dev${path}`, {}, env)
      const body = await res.text()

      expect(res.status).toBe(404)
      expect(body).not.toContain('<div id="root"></div>')
    }
  })

  it('keeps optional protocol routes out of SPA fallback', async () => {
    const { ctx } = await buildTestTenant()
    const app = makeOidcApp(ctx, registerOidcRoutes)
    const env = makeOidcEnv({ CACHE: makeKv() })

    const checks: Array<{
      path: string
      init?: RequestInit
      expectStatus: number
    }> = [
      { path: '/.well-known/ssf-configuration', expectStatus: 501 },
      { path: '/check_session', expectStatus: 200 },
      {
        path: '/backchannel_authentication',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        },
        expectStatus: 401,
      },
      {
        path: '/federation_registration',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
        expectStatus: 401,
      },
      { path: '/heart/metadata', expectStatus: 200 },
      {
        path: '/gnap/tx',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
        expectStatus: 501,
      },
      {
        path: '/oid4vci/credential',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
        expectStatus: 400,
      },
    ]
    for (const check of checks) {
      const res = await app.request(`https://acme.xid.dev${check.path}`, check.init ?? {}, env)
      const body = await res.text()
      expect(res.status).toBe(check.expectStatus)
      expect(body).not.toContain('<div id="root"></div>')
    }
  })
})
