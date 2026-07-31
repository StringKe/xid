import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'

const connectionFindOne = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    ssoConnections: { findOne: connectionFindOne },
  })),
  schema: {
    ssoConnections: { id: 'id' },
  },
}))

import { resolveConnection } from '../saml-connection'

const TENANT = {
  tenantId: 'tenant_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'kid_1', defaultAlg: 'ES256' as const, keys: [] },
  policy: {},
}

function makeContext(environment = 'production'): Context<XidHonoEnv> {
  return {
    env: { DB: {} as D1Database, ENVIRONMENT: environment } as Env,
    get: (key: string) => (key === 'tenant' ? TENANT : undefined),
  } as unknown as Context<XidHonoEnv>
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    tenantId: 'tenant_1',
    orgId: 'org_1',
    protocol: 'saml',
    status: 'active',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpSloUrl: 'https://idp.example.com/slo',
    idpMetadataUrl: 'https://idp.example.com/metadata',
    ...overrides,
  }
}

describe('resolveConnection URL runtime validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts active SAML connections with public HTTPS endpoints', async () => {
    connectionFindOne.mockResolvedValue(connection())

    await expect(resolveConnection(makeContext(), 'conn_1')).resolves.toMatchObject({
      id: 'conn_1',
    })
  })

  it('allows loopback HTTP endpoints only in development or test', async () => {
    connectionFindOne.mockResolvedValue(
      connection({
        idpSsoUrl: 'http://127.0.0.1:8787/test/fake-idp/saml/sso',
        idpSloUrl: 'http://127.0.0.1:8787/test/fake-idp/saml/slo',
        idpMetadataUrl: 'http://127.0.0.1:8787/test/fake-idp/saml/metadata',
      }),
    )

    await expect(resolveConnection(makeContext('development'), 'conn_1')).resolves.toMatchObject({
      id: 'conn_1',
    })
    await expect(resolveConnection(makeContext('production'), 'conn_1')).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) && error.code === 'connection_not_found' && error.httpStatus === 404,
    )
  })

  it.each([
    { idpSsoUrl: 'http://idp.example.com/sso' },
    { idpSsoUrl: 'https://169.254.169.254/sso' },
    { idpSloUrl: 'https://127.0.0.1/slo' },
    { idpMetadataUrl: 'https://10.0.0.1/metadata' },
  ])('rejects invalid stored endpoints without exposing the row: %o', async (overrides) => {
    connectionFindOne.mockResolvedValue(connection(overrides))

    await expect(resolveConnection(makeContext(), 'conn_1')).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) && error.code === 'connection_not_found' && error.httpStatus === 404,
    )
  })
})
