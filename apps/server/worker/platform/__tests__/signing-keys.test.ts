import { TOKEN_POLICY_BOUNDS } from '@xid-kit/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JWKS_CACHE_TTL_SEC } from '../../lib/ttl'
import type { SessionData } from '../../lib/types'
import {
  asUnknown,
  buildApp,
  makeSession,
  stepUpCookieFor,
  TEST_PEPPER,
} from '../../me/__tests__/harness'
import { seedOrganization, seedUser, SqliteD1 } from '../../me/__tests__/sqlite-d1'
import { registerPlatformSigningKeyRoutes } from '../signing-keys'

vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const NOW = Date.UTC(2026, 9, 9, 12)
const HOUR_MS = 60 * 60 * 1000
const BASE = 'https://xid.dev/v1/platform/signing-keys'

type KeyStatus = 'next' | 'active' | 'retiring' | 'retired'

function seedInstance(db: SqliteD1): void {
  db.insert('instances', {
    id: 'inst_1',
    name: 'XID',
    primary_domain: 'xid.dev',
    mode: 'multi_tenant',
    default_locale: 'en',
    data_residency: 'us',
    mfa_policy: 'optional',
    password_policy: '{}',
    session_policy: '{}',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  })
}

function seedKey(db: SqliteD1, input: { kid: string; status: KeyStatus; createdAt: number }): void {
  db.insert('instance_signing_keys', {
    id: `sk_${input.kid}`,
    instance_id: 'inst_1',
    kid: input.kid,
    alg: 'ES256',
    public_key_jwk: JSON.stringify({ kty: 'EC', kid: input.kid }),
    private_key_iv: new Uint8Array([1, 2, 3]),
    private_key_ciphertext: new Uint8Array([4, 5, 6]),
    private_key_tag: new Uint8Array([7, 8, 9]),
    kek_version: 1,
    status: input.status,
    activated_at: input.status === 'active' ? input.createdAt : null,
    retire_after: null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  })
}

function seedInstanceManager(db: SqliteD1, userId: string): void {
  db.insert('manager_assignments', {
    id: `mgr_${userId}`,
    tenant_id: 't_1',
    user_id: userId,
    manager_role: 'instance_manager',
    scope_type: 'instance',
    scope_id: null,
    created_at: NOW,
    updated_at: NOW,
  })
}

function seedTotpFactor(db: SqliteD1, userId: string): void {
  db.insert('mfa_factors', {
    id: `mfa_${userId}`,
    tenant_id: 't_1',
    user_id: userId,
    factor_type: 'totp',
    status: 'active',
    is_default: 1,
    activated_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  })
}

type Harness = {
  db: SqliteD1
  env: Env
  cacheDelete: ReturnType<typeof vi.fn>
  auditSend: ReturnType<typeof vi.fn>
  session: SessionData
}

function harness(options: { manager?: boolean } = {}): Harness {
  const db = new SqliteD1()
  seedInstance(db)
  seedOrganization(db, { id: 't_1', tenantId: 't_1' })
  seedUser(db, { id: 'u_admin', tenantId: 't_1' })
  if (options.manager !== false) seedInstanceManager(db, 'u_admin')
  seedTotpFactor(db, 'u_admin')
  seedKey(db, { kid: 'key_old', status: 'retiring', createdAt: NOW - 200 * 24 * HOUR_MS })
  seedKey(db, { kid: 'key_active', status: 'active', createdAt: NOW - 90 * 24 * HOUR_MS })
  seedKey(db, { kid: 'key_next', status: 'next', createdAt: NOW - 2 * HOUR_MS })
  seedKey(db, { kid: 'key_retired', status: 'retired', createdAt: NOW - 400 * 24 * HOUR_MS })
  const cacheDelete = vi.fn(async () => undefined)
  const auditSend = vi.fn(async () => undefined)
  const env = asUnknown<Env>({
    DB: db.asD1(),
    CACHE: { delete: cacheDelete },
    AUDIT_QUEUE: { send: auditSend },
    PEPPER: TEST_PEPPER,
  })
  return { db, env, cacheDelete, auditSend, session: makeSession({ userId: 'u_admin' }) }
}

function appFor(session: SessionData) {
  return buildApp({ register: registerPlatformSigningKeyRoutes, session })
}

async function activate(h: Harness, kid: string, withStepUp = true): Promise<Response> {
  const headers: Record<string, string> = withStepUp
    ? { cookie: await stepUpCookieFor(h.session) }
    : {}
  return appFor(h.session).request(`${BASE}/${kid}/activate`, { method: 'POST', headers }, h.env)
}

function statuses(db: SqliteD1): Record<string, unknown> {
  return Object.fromEntries(
    db
      .rows('SELECT kid, status FROM instance_signing_keys')
      .map((row) => [row['kid'], row['status']]),
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /v1/platform/signing-keys', () => {
  it('lists next, active and retiring keys without private key material', async () => {
    const h = harness()

    const res = await appFor(h.session).request(BASE, undefined, h.env)

    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toMatch(/private|ciphertext|iv"|tag"|kek/i)
    const body = JSON.parse(raw) as {
      data: { kid: string; status: string; activatableAt: number | null }[]
    }
    expect(body.data.map((key) => [key.kid, key.status])).toEqual([
      ['key_next', 'next'],
      ['key_active', 'active'],
      ['key_old', 'retiring'],
    ])
    expect(body.data[0]?.activatableAt).toBe(NOW - 2 * HOUR_MS + JWKS_CACHE_TTL_SEC * 1000)
  })

  it('rejects a session without an instance_manager assignment', async () => {
    const h = harness({ manager: false })

    const res = await appFor(h.session).request(BASE, undefined, h.env)

    expect(res.status).toBe(403)
  })
})

describe('POST /v1/platform/signing-keys/:kid/activate', () => {
  it('rejects a session without an instance_manager assignment', async () => {
    const h = harness({ manager: false })

    const res = await activate(h, 'key_next')

    expect(res.status).toBe(403)
    expect(statuses(h.db)['key_next']).toBe('next')
  })

  it('requires a fresh step-up and leaves the keys untouched without one', async () => {
    const h = harness()

    const res = await activate(h, 'key_next', false)

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('step_up_required')
    expect(statuses(h.db)).toMatchObject({ key_next: 'next', key_active: 'active' })
    expect(h.db.rows('SELECT id FROM platform_audit_outbox')).toHaveLength(0)
  })

  it('rejects a key whose status is not next', async () => {
    const h = harness()

    const res = await activate(h, 'key_old')

    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('conflict')
    expect(statuses(h.db)).toMatchObject({ key_old: 'retiring', key_active: 'active' })
  })

  it('rejects a next key published less than one JWKS cache TTL ago', async () => {
    const h = harness()
    h.db.rows(
      "UPDATE instance_signing_keys SET created_at = ? WHERE kid = 'key_next'",
      NOW - 30 * 60 * 1000,
    )

    const res = await activate(h, 'key_next')

    expect(res.status).toBe(409)
    expect(statuses(h.db)).toMatchObject({ key_next: 'next', key_active: 'active' })
    expect(h.db.rows('SELECT id FROM platform_audit_outbox')).toHaveLength(0)
  })

  it('returns 404 for an unknown kid and 422 for an oversized one', async () => {
    const h = harness()

    const missing = await activate(h, 'key_missing')
    const oversized = await activate(h, 'k'.repeat(129))

    expect(missing.status).toBe(404)
    expect(oversized.status).toBe(422)
  })

  it('promotes next to active, retires the previous key and records the audit', async () => {
    const h = harness()

    const res = await activate(h, 'key_next')

    expect(res.status).toBe(200)
    const active = h.db.rows(
      "SELECT kid, activated_at FROM instance_signing_keys WHERE status = 'active'",
    )
    expect(active).toEqual([{ kid: 'key_next', activated_at: NOW }])
    const [previous] = h.db.rows(
      "SELECT status, retire_after FROM instance_signing_keys WHERE kid = 'key_active'",
    )
    expect(previous).toEqual({
      status: 'retiring',
      retire_after:
        NOW + TOKEN_POLICY_BOUNDS.accessTokenTtlSec.max * 1000 + JWKS_CACHE_TTL_SEC * 1000,
    })
    const audits = h.db.rows('SELECT action, actor_id, payload FROM platform_audit_outbox')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'platform.signing_key.activated',
      actor_id: 'u_admin',
    })
    expect(JSON.parse(String(audits[0]?.['payload']))).toMatchObject({
      kid: 'key_next',
      previousKid: 'key_active',
    })
    expect(h.auditSend).toHaveBeenCalledTimes(1)
    expect(h.cacheDelete).toHaveBeenCalledWith('jwks:https://xid.dev:key_active')
  })

  it('rejects a second activation of the same key', async () => {
    const h = harness()
    await activate(h, 'key_next')

    const again = await activate(h, 'key_next')

    expect(again.status).toBe(409)
    expect(h.db.rows("SELECT kid FROM instance_signing_keys WHERE status = 'active'")).toHaveLength(
      1,
    )
    expect(h.db.rows('SELECT id FROM platform_audit_outbox')).toHaveLength(1)
  })
})
