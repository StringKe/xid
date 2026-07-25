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

import { storeInboundSamlSessionIndex } from '../saml-session-bindings'

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
