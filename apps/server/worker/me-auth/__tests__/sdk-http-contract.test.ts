// Cross-package HTTP contract test. Requests originate from the real @xid-kit/core clients and are
// handled by the real Worker route registration and serializers; only persistence/crypto are faked.

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionData, XidHonoEnv } from '../../lib/types'

const contractState = vi.hoisted(() => ({
  session: null as SessionData | null,
  activeOrganizationUpdates: [] as Array<string | null>,
}))

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (scope: string) => scope }))

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    createTenantDb: vi.fn(() => ({
      sessions: {
        update: vi.fn(async ({ activeOrgId }: { activeOrgId: string | null }) => {
          contractState.activeOrganizationUpdates.push(activeOrgId)
        }),
      },
    })),
  }
})

vi.mock('@xid-kit/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/protocol')>()
  return {
    ...actual,
    buildAccessTokenClaims: vi.fn().mockReturnValue({ sub: 'user-1', sid: 'session-1' }),
    signAccessTokenClaims: vi.fn().mockResolvedValue('signed.session.jwt'),
  }
})

vi.mock('../../oidc/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../oidc/shared')>()
  return {
    ...actual,
    loadActiveSigner: vi.fn().mockResolvedValue({
      kid: 'k1',
      alg: 'ES256',
      privateKey: {},
    }),
  }
})

vi.mock('../../lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/session')>()
  return {
    ...actual,
    readSession: vi.fn(async () => contractState.session),
    selectSessionById: vi.fn(async (_context: unknown, sessionId: string) => {
      const selected: SessionData = {
        sessionId,
        userId: 'user-selected',
        status: 'active',
        activeOrgId: null,
        authenticatedAt: new Date(),
        lastActiveAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        rememberMe: false,
        isImpersonation: false,
        impersonatorUserId: null,
        acr: null,
        amr: ['pwd'],
        aal: 1,
      }
      contractState.session = selected
      return selected
    }),
    revokeSession: vi.fn(async () => {
      contractState.session = null
    }),
  }
})

vi.mock('../../sso/outbound-saml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sso/outbound-saml')>()
  return { ...actual, initiateOutboundSamlLogout: vi.fn().mockResolvedValue(null) }
})

import { XidApiClient } from '../../../../../packages/core/src/api-client'
import { XidClient } from '../../../../../packages/core/src/client'
import { registerMeRoute } from '../../me/me'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeEnv, makeSession, makeTenant, testErrorHandler } from './helpers'

const TARGET_SESSION_ID = 'sess_AbCdEfGhIjKlMnOpQrStu'

function createContractFetch(): {
  fetcher: typeof fetch
  paths: string[]
  responses: Response[]
} {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', makeTenant() as never)
    c.set('session', contractState.session)
    await next()
  })
  registerSessionAuthRoutes(app)
  registerMeRoute(app)

  const paths: string[] = []
  const responses: Response[] = []
  const env = makeEnv()
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
    const url = new URL(raw, 'https://xid.dev')
    paths.push(url.pathname)
    const response = await app.request(new Request(url, init), env, execCtx)
    responses.push(response.clone())
    return response
  }) as typeof fetch
  return { fetcher, paths, responses }
}

describe('Worker router <-> @xid-kit/core session HTTP contract', () => {
  beforeEach(() => {
    contractState.session = null
    contractState.activeOrganizationUpdates = []
    vi.clearAllMocks()
  })

  it('loads the real anonymous /v1/me shell without throwing or entering degraded state', async () => {
    const { fetcher, paths } = createContractFetch()
    const client = new XidClient({ fetcher })

    await expect(client.load()).resolves.toBeUndefined()

    expect(paths).toEqual(['/v1/me'])
    expect(client.getSnapshot()).toMatchObject({
      status: 'ready',
      isLoaded: true,
      isSignedIn: false,
      user: null,
      session: null,
      sessions: [],
    })
  })

  it('consumes the Worker token field without a package-local response mock', async () => {
    contractState.session = makeSession('user-1', TARGET_SESSION_ID)
    const { fetcher, paths } = createContractFetch()
    const client = new XidClient({ fetcher })

    const result = await client.getToken()

    expect(result).toEqual({ ok: true, value: 'signed.session.jwt' })
    expect(paths).toEqual(['/v1/sessions/token'])
  })

  it('uses the registered active-session route and receives its Set-Cookie pointer', async () => {
    contractState.session = makeSession()
    const { fetcher, paths, responses } = createContractFetch()
    const api = new XidApiClient({ fetcher })

    const result = await api.setActiveSession({ sessionId: TARGET_SESSION_ID })

    expect(result).toEqual({ ok: true, value: { activeSessionId: TARGET_SESSION_ID } })
    expect(paths).toEqual(['/v1/sessions/active'])
    expect(responses[0]?.headers.get('set-cookie')).toContain(
      `__Host-xid.active=${TARGET_SESSION_ID}`,
    )
  })

  it('shares the active-organization response shape with the Worker serializer', async () => {
    contractState.session = makeSession('user-1', TARGET_SESSION_ID)
    const { fetcher, paths } = createContractFetch()
    const api = new XidApiClient({ fetcher })

    const result = await api.setActiveOrganization({ organizationId: null })

    expect(result).toMatchObject({
      ok: true,
      value: {
        session: {
          id: TARGET_SESSION_ID,
          isImpersonation: false,
        },
        activeOrganizationId: null,
      },
    })
    expect(paths).toEqual(['/v1/sessions/active-organization'])
    expect(contractState.activeOrganizationUpdates).toEqual([null])
  })

  it('uses /auth/sign-out and then consumes the real anonymous /v1/me response', async () => {
    contractState.session = makeSession('user-1', TARGET_SESSION_ID)
    const { fetcher, paths } = createContractFetch()
    const client = new XidClient({ fetcher })

    const result = await client.signOut()

    expect(result).toEqual({ ok: true, value: null })
    expect(paths).toEqual(['/auth/sign-out', '/v1/me'])
    expect(client.getSnapshot()).toMatchObject({
      status: 'ready',
      isSignedIn: false,
      user: null,
      session: null,
    })
  })
})
