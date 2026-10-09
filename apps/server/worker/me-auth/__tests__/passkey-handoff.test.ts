// 多主机 passkey 登录:根域只解析组织并把仪式交给组织子域,子域验签后签发一次性交接 grant,
// 根域核对 __Host- state cookie 后消费 grant、建立根域会话并续跑 /authorize。
// 负向:没有或错误的 state cookie、别的组织、别的主机、重放都失败,且不签发会话。

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveInstanceLoginCandidates: vi.fn(),
  resolveTenantContextById: vi.fn(),
  resolveTenantContextByApplicationClientId: vi.fn(),
  schema: {
    passkeyCredentials: { credentialId: 'credentialId', userId: 'userId' },
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
import { Hono } from 'hono'
import { SessionHandoffDO } from '../../durable-objects/session-handoff-do'
import { MockDurableObjectState } from '../../durable-objects/__tests__/mock-do-state'
import { registerPasskeyRoutes } from '../../auth/passkey'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeTenant } from './helpers'

const ROOT = 'https://xid.dev'
const ACME = 'https://acme.xid.dev'
const CONTINUE = '/authorize?authz_request_id=req_1&client_id=client_acme'

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
  resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
})
const OTHER_FROM_ROOT = tenantFor('org_other', 'other.xid.dev', {
  resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
})

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
  const sessionsInsert = vi.fn().mockResolvedValue({
    id: 'sess_1',
    userId: 'user_1',
    activeOrgId: 'org_acme',
    authenticatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    rememberMe: true,
    isImpersonation: false,
    impersonatorUserId: null,
  })
  const db = {
    passkeyCredentials: {
      findOne: vi
        .fn()
        .mockResolvedValue({ userId: 'user_1', signCount: 1, credentialId: 'cred_1' }),
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

function hostApp(tenant: TenantVar): Hono<XidHonoEnv> {
  const app = makeApp(registerSessionAuthRoutes, { tenant })
  registerPasskeyRoutes(app)
  return app
}

async function rootChallenge(env: Env): Promise<{ origin: string; state: string }> {
  vi.mocked(resolveTenantContextById).mockResolvedValue({
    ok: true,
    value: { status: 'resolved', tenant: ACME_FROM_ROOT },
  } as never)
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
  const body = (await res.json()) as { ceremony: { origin: string; state: string } }
  return body.ceremony
}

type HandoffForm = { action: string; fields: Record<string, string> }

async function subdomainVerify(env: Env, state: string): Promise<HandoffForm> {
  vi.mocked(resolveTenantContextByApplicationClientId).mockResolvedValue({
    ok: true,
    value: ACME_FROM_ROOT,
  } as never)
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
        continue: CONTINUE,
        handoffState: state,
      }),
    },
    env,
    execCtx,
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { handoff: HandoffForm }).handoff
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

function multiHostEnv(): Env {
  return { ...makeEnv(), SESSION_HANDOFF: handoffNamespace() } as unknown as Env
}

describe('passkey sign-in across the instance root and the organization host', () => {
  let sessionsInsert: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: { signCount: 2, signCountAnomaly: false, credentialBackedUp: true },
    } as never)
    const prepared = tenantDb()
    sessionsInsert = prepared.sessionsInsert
    vi.mocked(createTenantDb).mockReturnValue(prepared.db as never)
  })

  it('hands the ceremony to the organization host and resumes /authorize on the root', async () => {
    const env = multiHostEnv()

    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: ACME_FROM_ROOT },
    } as never)
    const consumed = await consume(env, {
      tenant: ROOT_ENTRY,
      origin: ROOT,
      form,
      cookie: ceremony.state,
    })

    expect(ceremony.origin).toBe(ACME)
    expect(verifyAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRpId: 'acme.xid.dev' }),
    )
    expect(form.action).toBe(`${ROOT}/auth/passkey/handoff`)
    expect(JSON.stringify(form)).not.toContain(ceremony.state)
    expect(consumed.status).toBe(303)
    expect(consumed.headers.get('location')).toBe(CONTINUE)
    expect(consumed.headers.get('set-cookie')).toContain('__Host-xid.rt.')
    expect(sessionsInsert).toHaveBeenCalledTimes(2)
  })

  it('rejects the grant without the root state cookie and issues no root session', async () => {
    const env = multiHostEnv()
    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    sessionsInsert.mockClear()

    const consumed = await consume(env, { tenant: ROOT_ENTRY, origin: ROOT, form })

    expect(consumed.status).toBe(401)
    expect(sessionsInsert).not.toHaveBeenCalled()
  })

  it('rejects a grant presented with another browser state', async () => {
    const env = multiHostEnv()
    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    sessionsInsert.mockClear()
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: ACME_FROM_ROOT },
    } as never)

    const consumed = await consume(env, {
      tenant: ROOT_ENTRY,
      origin: ROOT,
      form,
      cookie: 'A'.repeat(43),
    })

    expect(consumed.status).toBe(401)
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

    expect(consumed.status).toBe(401)
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

    expect(consumed.status).toBe(401)
    expect(sessionsInsert).not.toHaveBeenCalled()
  })

  it('accepts a grant only once', async () => {
    const env = multiHostEnv()
    const ceremony = await rootChallenge(env)
    const form = await subdomainVerify(env, ceremony.state)
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: ACME_FROM_ROOT },
    } as never)
    const input = { tenant: ROOT_ENTRY, origin: ROOT, form, cookie: ceremony.state }

    const first = await consume(env, input)
    const replay = await consume(env, input)

    expect(first.status).toBe(303)
    expect(replay.status).toBe(401)
  })

  it('keeps a local sign-in on the organization host without a handoff', async () => {
    const env = multiHostEnv()
    const res = await hostApp(ACME_TENANT).request(
      `${ACME}/auth/passkey/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'handle-1',
          rawId: 'cred_1',
          response: { clientDataJSON: 'cdj', authenticatorData: 'ad', signature: 'sig' },
          continue: '/account',
          handoffState: 'B'.repeat(43),
        }),
      },
      env,
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ redirectUrl: '/account' })
  })
})
