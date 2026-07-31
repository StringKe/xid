// saml-session-bindings.ts 单元测试:SessionIndex 映射 TTL 写入 D1(非 ChallengeStore 10min 上限)。

import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertMock = vi.fn()
const updateMock = vi.fn()
const findOneMock = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    samlSessionBindings: {
      insert: insertMock,
      update: updateMock,
      findOne: findOneMock,
      findMany: vi.fn(),
    },
  })),
  schema: {
    samlSessionBindings: {
      id: 'id',
      direction: 'direction',
      scopeId: 'scopeId',
      sessionIndex: 'sessionIndex',
      consumedAt: 'consumedAt',
      expiresAt: 'expiresAt',
      nameId: 'nameId',
      userId: 'userId',
      sessionId: 'sessionId',
    },
  },
}))

import {
  resolveInboundSamlSessionByNameId,
  resolveInboundSamlSessionIndex,
  resolveOutboundSamlSessionByNameId,
  resolveOutboundSamlSessionIndex,
  restoreConsumedSamlSessionBindings,
  storeInboundSamlSessionIndex,
} from '../saml-session-bindings'
import type { ConsumedSamlSessionBinding } from '../saml-session-bindings'

const TENANT = {
  tenantId: 'tenant_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function makeContext() {
  return {
    env: { DB: {} },
    get: (key: string) => (key === 'tenant' ? TENANT : undefined),
  } as unknown as Parameters<typeof storeInboundSamlSessionIndex>[0]['c']
}

function makeAtomicConsumeContext(results: ConsumedSamlSessionBinding[]) {
  const all = vi.fn().mockResolvedValue({ results })
  const bind = vi.fn(() => ({ all }))
  const prepare = vi.fn(() => ({ bind }))
  const batch = vi.fn().mockResolvedValue(results.map(() => ({ meta: { changes: 1 } })))
  const context = {
    env: { DB: { prepare, batch } },
    get: (key: string) => (key === 'tenant' ? TENANT : undefined),
  } as unknown as Parameters<typeof resolveInboundSamlSessionIndex>[0]
  return { context, prepare, bind, all, batch }
}

describe('storeInboundSamlSessionIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findOneMock.mockResolvedValue(undefined)
    insertMock.mockResolvedValue({ id: 'binding_1' })
  })

  it('persists session-length TTL to D1 without ChallengeStore cap', async () => {
    const ttlMs = 30 * 24 * 60 * 60 * 1000
    const before = Date.now()
    await storeInboundSamlSessionIndex({
      c: makeContext(),
      connectionId: 'conn_1',
      sessionIndex: '_session_abc',
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      binding: { userId: 'user_1', sessionId: 'sess_1' },
      ttlMs,
    })

    expect(insertMock).toHaveBeenCalledOnce()
    const row = insertMock.mock.calls[0]?.[0] as { expiresAt: Date; sessionIndex: string }
    expect(row.sessionIndex).toBe('_session_abc')
    expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(ttlMs - 1000)
    expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(ttlMs + 5000)
  })
})

describe('atomic SAML session binding consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['inbound', resolveInboundSamlSessionIndex, 'conn_1'],
    ['outbound', resolveOutboundSamlSessionIndex, 'app_1'],
  ] as const)(
    'claims one %s SessionIndex with one conditional UPDATE',
    async (direction, resolve, scopeId) => {
      const binding = {
        bindingId: 'binding_1',
        consumedAt: 1_000,
        userId: 'user_1',
        sessionId: 'sess_1',
      }
      const { context, prepare, bind } = makeAtomicConsumeContext([binding])

      await expect(resolve(context, scopeId, '_session_1')).resolves.toEqual(binding)

      expect(prepare).toHaveBeenCalledOnce()
      expect(String(prepare.mock.calls[0]?.[0]).replace(/\s+/g, ' ')).toContain(
        'UPDATE saml_session_bindings',
      )
      expect(String(prepare.mock.calls[0]?.[0])).toContain('user_id AS userId')
      expect(bind).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        'tenant_1',
        direction,
        scopeId,
        '_session_1',
        expect.any(Number),
      )
    },
  )

  it.each([
    ['inbound', resolveInboundSamlSessionByNameId, 'conn_1'],
    ['outbound', resolveOutboundSamlSessionByNameId, 'app_1'],
  ] as const)(
    'atomically claims every valid %s NameID mapping',
    async (direction, resolve, scopeId) => {
      const bindings = [
        { bindingId: 'binding_1', consumedAt: 1_000, userId: 'user_1', sessionId: 'sess_1' },
        { bindingId: 'binding_2', consumedAt: 1_000, userId: 'user_1', sessionId: 'sess_2' },
      ]
      const { context, prepare, bind } = makeAtomicConsumeContext(bindings)

      await expect(resolve(context, scopeId, 'user@example.com')).resolves.toEqual(bindings)

      expect(prepare).toHaveBeenCalledOnce()
      expect(String(prepare.mock.calls[0]?.[0])).toContain('AND name_id = ?')
      expect(bind).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        'tenant_1',
        direction,
        scopeId,
        'user@example.com',
        expect.any(Number),
      )
    },
  )

  it('restores only the exact binding IDs and consume timestamps from a failed request', async () => {
    const bindings: ConsumedSamlSessionBinding[] = [
      { bindingId: 'binding_1', consumedAt: 1_000, userId: 'user_1', sessionId: 'sess_1' },
      { bindingId: 'binding_2', consumedAt: 1_001, userId: 'user_1', sessionId: 'sess_2' },
    ]
    const { context, prepare, bind, batch } = makeAtomicConsumeContext(bindings)

    await restoreConsumedSamlSessionBindings(context, {
      direction: 'inbound',
      scopeId: 'conn_1',
      bindings,
    })

    expect(prepare).toHaveBeenCalledTimes(2)
    expect(String(prepare.mock.calls[0]?.[0])).toContain('SET consumed_at = NULL')
    expect(String(prepare.mock.calls[0]?.[0])).toContain('AND consumed_at = ?')
    expect(bind.mock.calls[0]?.slice(1)).toEqual([
      'binding_1',
      'tenant_1',
      'inbound',
      'conn_1',
      1_000,
    ])
    expect(bind.mock.calls[1]?.slice(1)).toEqual([
      'binding_2',
      'tenant_1',
      'inbound',
      'conn_1',
      1_001,
    ])
    expect(batch).toHaveBeenCalledOnce()
  })

  it('fails closed when any exact binding restoration no longer matches', async () => {
    const bindings: ConsumedSamlSessionBinding[] = [
      { bindingId: 'binding_1', consumedAt: 1_000, userId: 'user_1', sessionId: 'sess_1' },
      { bindingId: 'binding_2', consumedAt: 1_001, userId: 'user_1', sessionId: 'sess_2' },
    ]
    const { context, batch } = makeAtomicConsumeContext(bindings)
    batch.mockResolvedValueOnce([{ meta: { changes: 1 } }, { meta: { changes: 0 } }])

    await expect(
      restoreConsumedSamlSessionBindings(context, {
        direction: 'outbound',
        scopeId: 'app_1',
        bindings,
      }),
    ).rejects.toMatchObject({ code: 'server_error' })
  })
})
