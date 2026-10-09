import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import { ldapDirectBind } from '../ldap'
import { prepareLegacyAttributeMapping, type LegacyConnection } from '../legacy-shared'

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x43)))
const GATEWAY_URL = 'https://ldap-gw.acme-corp.net/bind'
const CONNECTION_SECRET = 's'.repeat(48)

function productionContext(): Context<XidHonoEnv> {
  return { env: { ENVIRONMENT: 'production', KEK } } as unknown as Context<XidHonoEnv>
}

function connectionWith(attributeMapping: Record<string, unknown>): LegacyConnection {
  return { id: 'conn-ldap', orgId: 'org-1', protocol: 'ldap', attributeMapping } as LegacyConnection
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isAppError(error)) return `${error.code}:${error.longMessage ?? ''}`
    throw error
  }
  throw new Error('expected rejection')
}

describe('ldapDirectBind in production', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authenticates to the gateway with the connection secret, not an instance secret', async () => {
    const mapping = await prepareLegacyAttributeMapping(
      'ldap',
      { _legacy: { ldapGatewayUrl: GATEWAY_URL, ldapGatewaySecret: CONNECTION_SECRET } },
      null,
      { KEK },
    )
    const fetchMock = vi.fn(async () =>
      Response.json({
        idpId: 'uid=alice',
        email: 'alice@acme-corp.net',
        emailVerified: true,
        firstName: null,
        lastName: null,
        groups: [],
        customAttributes: {},
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const profile = await ldapDirectBind(productionContext(), connectionWith(mapping), {
      username: 'alice',
      password: 'pw',
    })

    expect(profile?.idpId).toBe('uid=alice')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(GATEWAY_URL)
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${CONNECTION_SECRET}`)
  })

  it('fails closed without contacting the gateway when the connection has no secret', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const code = await errorCode(
      ldapDirectBind(
        productionContext(),
        connectionWith({ _legacy: { ldapGatewayUrl: GATEWAY_URL } }),
        {
          username: 'alice',
          password: 'pw',
        },
      ),
    )

    expect(code).toBe('internal_error:ldap_gateway_secret_not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends a password to a placeholder gateway URL stored by an old preset', async () => {
    const mapping = await prepareLegacyAttributeMapping(
      'ldap',
      { _legacy: { ldapGatewayUrl: GATEWAY_URL, ldapGatewaySecret: CONNECTION_SECRET } },
      null,
      { KEK },
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const code = await errorCode(
      ldapDirectBind(
        productionContext(),
        connectionWith({
          ...mapping,
          _legacy: { ldapGatewayUrl: 'https://ldap-gw.example.com/bind' },
        }),
        { username: 'alice', password: 'pw' },
      ),
    )

    expect(code).toBe('internal_error:ldap_gateway_not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
