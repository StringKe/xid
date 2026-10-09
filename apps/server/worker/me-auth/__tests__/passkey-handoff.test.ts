// 多主机 passkey:仪式只在组织 rpId 主机进行,根域与组织主机之间以一次性 grant 交接会话。
// 覆盖:根域登录 -> 子域验签 -> 根域续跑 /authorize;根域待 MFA 会话 -> 子域完成第二因子 -> 交回根域;
// 根域账户页登记 passkey -> 子域;以及缺 state、错 state、换组织、换主机、重放、无会话、外来来源的拒绝。

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveInstanceLoginCandidates: vi.fn(),
  resolveTenantContextById: vi.fn(),
  resolveTenantContextByApplicationClientId: vi.fn(),
  schema: {
    passkeyCredentials: {
      credentialId: 'credentialId',
      userId: 'userId',
      revokedAt: 'revokedAt',
    },
    users: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    sessions: { id: 'id' },
    memberships: { userId: 'userId', status: 'status', orgId: 'orgId' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
  },
}))

vi.mock('@xid-kit/webauthn', () => ({ verifyAuthentication: vi.fn() }))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

vi.mock('../../auth/passkey-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/passkey-helpers')>()
  return {
    ...actual,
    createChallenge: vi.fn().mockResolvedValue('chal-abc'),
    consumeChallenge: vi.fn().mockResolvedValue('chal-abc'),
    buildStoredCredential: vi.fn().mockReturnValue({}),
    persistSignCount: vi.fn().mockResolvedValue(undefined),
  }
})

import {
  createTenantDb,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextById,
} from '@xid-kit/db'
import { verifyAuthentication } from '@xid-kit/webauthn'
import type { Hono } from 'hono'
import { SessionHandoffDO } from '../../durable-objects/session-handoff-do'
import { MockDurableObjectState } from '../../durable-objects/__tests__/mock-do-state'
import { registerPasskeyRoutes } from '../../auth/passkey'
import type { SessionData, TenantVar, XidHonoEnv } from '../../lib/types'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

const ROOT = 'https://xid.dev'
const ACME = 'https://acme.xid.dev'
const AUTHORIZE = '/authorize?authz_request_id=req_1&client_id=client_acme'
const HANDOFF_FAILED = '/sign-in?error=handoff_failed'

function tenantFor(tenantId: string, rpId: string, extra: Record<string, unknown> = {}): TenantVar {
  return {
    ...makeTenant(tenantId),
    instanceId: 'inst_1',
    issuer: ROOT,
    rpId,
    ...extra,
  } as unknown as TenantVar
}

const ROOT_ENTRY = tenantFor('org_default', 'xid.dev', {
  resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
})
const ACME_TENANT = tenantFor('org_acme', 'acme.xid.dev')
const ACME_FROM_ROOT = tenantFor('org_acme', 'acme.xid.dev', {
  resolution: { kind: 'tenant', primaryDomain: 'xid.dev', sessionDerivedRoot: true },
})
const OTHER_FROM_ROOT = tenantFor('org_other', 'other.xid.dev', {
  resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
})

function sessionWith(status: SessionData['status']): SessionData {
  return {
    ...makeSession('user_1', 'sess_root'),
    status,
    acr: 'urn:xid:aal1',
    amr: ['pwd'],
    aal: 1,
    rememberMe: true,
  }
}

function handoffNamespace(): DurableObjectNamespace {
  const objects = new Map<string, SessionHandoffDO>()
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id.toString()
      if (!objects.has(name)) {
        const state = new MockDurableObjectState() as unknown as DurableObjectState
        objects.set(name, new SessionHandoffDO(state))
      }
      const target = objects.get(name)!
      return {
        fetch: (input: string, init?: RequestInit) => target.fetch(new Request(input, init)),
      } as unknown as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function tenantDb() {
  const sessionsInsert = vi.fn(async (row: Record<string, unknown>) => ({
    id: row['id'],
    userId: 'user_1',
    activeOrgId: 'org_acme',
    status: row['status'] ?? 'active',
    authenticatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    rememberMe: true,
    isImpersonation: false,
    impersonatorUserId: null,
  }))
  const db = {
    passkeyCredentials: {
      findOne: vi.fn().mockResolvedValue({
        userId: 'user_1',
        signCount: 1,
        credentialId: 'cred_1',
        rpId: 'acme.xid.dev',
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'pk_1',
          credentialId: 'cred_1',
          transports: [],
          deviceName: null,
          createdAt: new Date(),
          rpId: 'acme.xid.dev',
        },
      ]),
    },
    users: {
      findOne: vi.fn().mockResolvedValue({ id: 'user_1', status: 'active', deletedAt: null }),
    },
    memberships: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'mem_1', userId: 'user_1', orgId: 'org_acme', status: 'active' },
        ]),
    },
    organizations: {
      findOne: vi.fn().mockResolvedValue({ id: 'org_acme', status: 'active', deletedAt: null }),
      findMany: vi.fn().mockResolvedValue([{ id: 'org_acme', status: 'active', deletedAt: null }]),
    },
    sessions: { insert: sessionsInsert },
  }
  return { db, sessionsInsert }
}

function hostApp(tenant: TenantVar, session: SessionData | null = null): Hono<XidHonoEnv> {
  const app = makeApp(registerSessionAuthRoutes, { tenant, session })
  registerPasskeyRoutes(app)
  return app
}

function multiHostEnv(): Env {
  return { ...makeEnv(), SESSION_HANDOFF: handoffNamespace() } as unknown as Env
}

type HandoffForm = { action: string; fields: Record<string, string> }

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = new RegExp(`${name}=([^;]+)`).exec(header)
  if (!match?.[1]) throw new Error(`missing ${name} cookie`)
  return match[1]
}

function formFromHtml(html: string): HandoffForm {
  const action = /action="([^"]+)"/.exec(html)?.[1] ?? ''
  const fields: Record<string, string> = {}
  for (const match of html.matchAll(/name="([^"]+)" value="([^"]+)"/g)) {
    fields[match[1]!] = match[2]!
  }
  return { action, fields }
}

function consume(
  env: Env,
  input: { tenant: TenantVar; origin: string; form: HandoffForm; cookie?: string },
): Promise<Response> {
  return hostApp(input.tenant).request(
    `${input.origin}/auth/passkey/handoff`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(input.cookie ? { Cookie: `__Host-xid.handoff=${input.cookie}` } : {}),
      },
      body: new URLSearchParams(input.form.fields).toString(),
    },
    env,
    execCtx,
  )
}

// 浏览器跟随 prepare -> start:目标主机写 state,来源主机凭会话签发 grant 并返回自动提交表单。
async function followPrepare(
  env: Env,
  input: { prepareUrl: string; target: TenantVar; source: TenantVar; session: SessionData },
): Promise<{ state: string; form: HandoffForm; startStatus: number }> {
  const prepared = await hostApp(input.target).request(input.prepareUrl, {}, env, execCtx)
  expect(prepared.status).toBe(302)
  const state = cookieValue(prepared, '__Host-xid.handoff')
  const started = await hostApp(input.source, input.session).request(
    prepared.headers.get('location')!,
    {},
    env,
    execCtx,
  )
  return { state, form: formFromHtml(await started.text()), startStatus: started.status }
}

let sessionsInsert: ReturnType<typeof tenantDb>['sessionsInsert']

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthentication).mockResolvedValue({
    ok: true,
    value: {
      rpId: 'acme.xid.dev',
      signCount: 2,
      signCountAnomaly: false,
      credentialBackedUp: true,
    },
  } as never)
  const prepared = tenantDb()
  sessionsInsert = prepared.sessionsInsert
  vi.mocked(createTenantDb).mockReturnValue(prepared.db as never)
  vi.mocked(resolveTenantContextById).mockResolvedValue({
    ok: true,
    value: { status: 'resolved', tenant: ACME_FROM_ROOT },
  } as never)
  vi.mocked(resolveTenantContextByApplicationClientId).mockResolvedValue({
    ok: true,
    value: ACME_FROM_ROOT,
  } as never)
})

describe('passkey sign-in handed from the root to the organization host and back', () => {
  async function rootChallenge(env: Env): Promise<{ origin: string; state: string }> {
    const res = await hostApp(ROOT_ENTRY).request(
      `${ROOT}/auth/passkey/challenge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_acme' }),
      },
      env,
      execCtx,
    )
    return ((await res.json()) as { ceremony: { origin: string; state: string } }).ceremony
  }

  async function subdomainVerify(env: Env, state: string): Promise<HandoffForm> {
    const res = await hostApp(ACME_TENANT).request(
      `${ACME}/auth/passkey/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'handle-1',
          rawId: 'cred_1',
          response: { clientDataJSON: 'cdj', authenticatorData: 'ad', signature: 'sig' },
          clientId: 'client_acme',
          continue: AUTHORIZE,
          handoffState: state,
        }),
      },
      env,
      execCtx,
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { handoff: HandoffForm }).handoff
  }

  it('resumes /authorize on the root with an active session', async () => {
    const env = multiHostEnv()

    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    const consumed = await consume(env, {
      tenant: ROOT_ENTRY,
      origin: ROOT,
      form,
      cookie: ceremony.state,
    })

    expect(ceremony.origin).toBe(ACME)
    expect(form.action).toBe(`${ROOT}/auth/passkey/handoff`)
    expect(consumed.status).toBe(303)
    expect(consumed.headers.get('location')).toBe(AUTHORIZE)
    expect(sessionsInsert).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' }))
  })

  it.each([
    ['without the root state cookie', undefined],
    ['with another browser state', 'A'.repeat(43)],
  ])('sends the browser back to sign-in %s and issues no root session', async (_label, cookie) => {
    const env = multiHostEnv()
    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    sessionsInsert.mockClear()

    const consumed = await consume(env, {
      tenant: ROOT_ENTRY,
      origin: ROOT,
      form,
      ...(cookie ? { cookie } : {}),
    })

    expect(consumed.status).toBe(302)
    expect(consumed.headers.get('location')).toBe(HANDOFF_FAILED)
    expect(sessionsInsert).not.toHaveBeenCalled()
  })

  it('rejects a grant re-labelled for another organization', async () => {
    const env = multiHostEnv()
    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    sessionsInsert.mockClear()
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: OTHER_FROM_ROOT },
    } as never)

    const consumed = await consume(env, {
      tenant: ROOT_ENTRY,
      origin: ROOT,
      form: { ...form, fields: { ...form.fields, organizationId: 'org_other' } },
      cookie: ceremony.state,
    })

    expect(consumed.headers.get('location')).toBe(HANDOFF_FAILED)
    expect(sessionsInsert).not.toHaveBeenCalled()
  })

  it('rejects the grant on another organization host', async () => {
    const env = multiHostEnv()
    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    sessionsInsert.mockClear()

    const consumed = await consume(env, {
      tenant: tenantFor('org_other', 'other.xid.dev'),
      origin: 'https://other.xid.dev',
      form,
      cookie: ceremony.state,
    })

    expect(consumed.headers.get('location')).toBe(HANDOFF_FAILED)
    expect(sessionsInsert).not.toHaveBeenCalled()
  })

  it('accepts a grant only once', async () => {
    const env = multiHostEnv()
    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    const input = { tenant: ROOT_ENTRY, origin: ROOT, form, cookie: ceremony.state }

    const first = await consume(env, input)
    const replay = await consume(env, input)

    expect(first.status).toBe(303)
    expect(replay.headers.get('location')).toBe(HANDOFF_FAILED)
  })
})

describe('earlier passkeys on the organization host', () => {
  function challenge(tenant: TenantVar, origin: string, body: Record<string, unknown>) {
    return hostApp(tenant).request(
      `${origin}/auth/passkey/challenge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      multiHostEnv(),
      execCtx,
    )
  }

  it('offers the instance primary domain as rpId only when asked for an earlier passkey', async () => {
    const earlier = (await (await challenge(ACME_TENANT, ACME, { earlier: true })).json()) as {
      rpId?: string
    }
    const regular = (await (await challenge(ACME_TENANT, ACME, {})).json()) as { rpId?: string }

    expect(earlier.rpId).toBe('xid.dev')
    expect(regular.rpId).toBeUndefined()
  })

  it('never starts an earlier-passkey ceremony on the root', async () => {
    const res = await challenge(ROOT_ENTRY, ROOT, { organizationId: 'org_acme', earlier: true })

    const body = (await res.json()) as { ceremony?: unknown; challenge?: unknown }
    expect(body.ceremony).toBeDefined()
    expect(body.challenge).toBeUndefined()
  })
})

describe('root sessions handed to the organization host for passkey ceremonies', () => {
  it('moves a pending MFA session to the organization host without upgrading it', async () => {
    const env = multiHostEnv()
    const pending = sessionWith('pending_mfa')
    const options = await hostApp(ACME_FROM_ROOT, pending).request(
      `${ROOT}/auth/mfa/passkey/options`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          continue: `/mfa?method=passkey&redirect_to=${encodeURIComponent(AUTHORIZE)}`,
        }),
      },
      env,
      execCtx,
    )
    const { handoff } = (await options.json()) as { handoff: { url: string } }

    const { state, form } = await followPrepare(env, {
      prepareUrl: handoff.url,
      target: ACME_TENANT,
      source: ACME_FROM_ROOT,
      session: pending,
    })
    const consumed = await consume(env, { tenant: ACME_TENANT, origin: ACME, form, cookie: state })

    expect(handoff.url.startsWith(`${ACME}/auth/passkey/handoff/prepare?`)).toBe(true)
    expect(form.action).toBe(`${ACME}/auth/passkey/handoff`)
    expect(consumed.status).toBe(303)
    const location = new URL(consumed.headers.get('location')!, ACME)
    expect(location.pathname).toBe('/mfa')
    expect(location.searchParams.get('redirect_to')).toBe(
      `/auth/passkey/handoff/return?continue=${encodeURIComponent(AUTHORIZE)}`,
    )
    expect(sessionsInsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'pending_mfa', userId: 'user_1' }),
    )
  })

  it('hands the session back to the root after the second factor and resumes /authorize', async () => {
    const env = multiHostEnv()
    const active = sessionWith('active')
    const returned = await hostApp(ACME_TENANT, active).request(
      `${ACME}/auth/passkey/handoff/return?continue=${encodeURIComponent(AUTHORIZE)}`,
      {},
      env,
      execCtx,
    )

    const { state, form } = await followPrepare(env, {
      prepareUrl: returned.headers.get('location')!,
      target: ROOT_ENTRY,
      source: ACME_TENANT,
      session: active,
    })
    const consumed = await consume(env, { tenant: ROOT_ENTRY, origin: ROOT, form, cookie: state })

    expect(
      returned.headers.get('location')!.startsWith(`${ROOT}/auth/passkey/handoff/prepare?`),
    ).toBe(true)
    expect(consumed.status).toBe(303)
    expect(consumed.headers.get('location')).toBe(AUTHORIZE)
    expect(sessionsInsert).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' }))
  })

  it('sends account passkey registration from the root to the organization host', async () => {
    const env = multiHostEnv()
    const active = sessionWith('active')
    const options = await hostApp(ACME_FROM_ROOT, active).request(
      `${ROOT}/auth/passkey/register/options`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ continue: '/account/security' }),
      },
      env,
      execCtx,
    )
    const { handoff } = (await options.json()) as { handoff: { url: string } }

    const { state, form } = await followPrepare(env, {
      prepareUrl: handoff.url,
      target: ACME_TENANT,
      source: ACME_FROM_ROOT,
      session: active,
    })
    const consumed = await consume(env, { tenant: ACME_TENANT, origin: ACME, form, cookie: state })

    expect(consumed.headers.get('location')).toBe('/account/security')
    expect(sessionsInsert).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' }))
  })

  it('refuses to start a handoff without a session', async () => {
    const env = multiHostEnv()

    const started = await hostApp(ACME_FROM_ROOT).request(
      `${ROOT}/auth/passkey/handoff/start?state=${'S'.repeat(43)}&target=${encodeURIComponent(ACME)}&continue=%2Faccount%2Fsecurity`,
      {},
      env,
      execCtx,
    )

    expect(started.status).toBe(302)
    expect(started.headers.get('location')).toBe(HANDOFF_FAILED)
  })

  it('refuses a handoff to a host outside the tenant', async () => {
    const env = multiHostEnv()

    const started = await hostApp(ACME_FROM_ROOT, sessionWith('active')).request(
      `${ROOT}/auth/passkey/handoff/start?state=${'S'.repeat(43)}&target=${encodeURIComponent('https://other.xid.dev')}&continue=%2Faccount%2Fsecurity`,
      {},
      env,
      execCtx,
    )

    expect(started.headers.get('location')).toBe(HANDOFF_FAILED)
  })

  it('refuses to prepare a handoff for a source outside the instance', async () => {
    const env = multiHostEnv()

    const prepared = await hostApp(ACME_TENANT).request(
      `${ACME}/auth/passkey/handoff/prepare?from=${encodeURIComponent('https://evil.example')}&continue=%2Faccount%2Fsecurity`,
      {},
      env,
      execCtx,
    )

    expect(prepared.headers.get('location')).toBe(HANDOFF_FAILED)
    expect(prepared.headers.get('set-cookie')).toBeNull()
  })
})
