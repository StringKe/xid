import type { TenantContext } from '@xid-kit/types'
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'

const resolveTenantContextById = vi.hoisted(() => vi.fn())
const resolveTenantContextBySamlServiceProvider = vi.hoisted(() => vi.fn())
const resolveTenantContextBySsoConnection = vi.hoisted(() => vi.fn())

vi.mock('@xid-kit/db', () => ({
  resolveTenantContextById,
  resolveTenantContextBySamlServiceProvider,
  resolveTenantContextBySsoConnection,
}))

import { resolveSamlServiceProviderTenant, resolveSsoConnectionTenant } from '../tenant'

const COOKIE_TENANT: TenantContext = {
  tenantId: 'tenant_cookie',
  issuer: 'https://xid.dev',
  rpId: 'cookie.xid.dev',
  resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
  signingKeys: { activeKid: 'cookie_key', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

const PATH_TENANT: TenantContext = {
  tenantId: 'tenant_path',
  issuer: 'https://xid.dev',
  rpId: 'path.xid.dev',
  resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
  signingKeys: { activeKid: 'path_key', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function makeContext(url: string, tenant = COOKIE_TENANT): Context<XidHonoEnv> {
  return {
    req: { raw: new Request(url) },
    env: {} as Env,
    get: (key: string) => (key === 'tenant' ? tenant : undefined),
  } as unknown as Context<XidHonoEnv>
}

describe('SAML path tenant resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the inbound connection path tenant over a root refresh-cookie tenant', async () => {
    resolveTenantContextBySsoConnection.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: PATH_TENANT },
    })
    const c = makeContext('https://xid.dev/sso/saml/conn_path/slo')

    await expect(resolveSsoConnectionTenant(c, 'conn_path')).resolves.toBe(PATH_TENANT)
    expect(resolveTenantContextBySsoConnection).toHaveBeenCalledWith(c.req.raw, c.env, 'conn_path')
  })

  it('uses the outbound app path tenant over a root refresh-cookie tenant', async () => {
    resolveTenantContextBySamlServiceProvider.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: PATH_TENANT },
    })
    const c = makeContext('https://xid.dev/sso/outbound/saml/sp_path/slo')

    await expect(resolveSamlServiceProviderTenant(c, 'sp_path')).resolves.toBe(PATH_TENANT)
    expect(resolveTenantContextBySamlServiceProvider).toHaveBeenCalledWith(
      c.req.raw,
      c.env,
      'sp_path',
    )
  })

  it('fails closed when a root path identifier cannot resolve', async () => {
    resolveTenantContextBySsoConnection.mockResolvedValue({
      ok: false,
      error: { code: 'tenant_not_found', message: 'hidden', httpStatus: 404 },
    })

    await expect(
      resolveSsoConnectionTenant(
        makeContext('https://xid.dev/sso/saml/conn_unknown/slo'),
        'conn_unknown',
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'connection_not_found',
    )
  })

  it('fails closed when a root outbound app path identifier cannot resolve', async () => {
    resolveTenantContextBySamlServiceProvider.mockResolvedValue({
      ok: false,
      error: { code: 'tenant_not_found', message: 'hidden', httpStatus: 404 },
    })

    await expect(
      resolveSamlServiceProviderTenant(
        makeContext('https://xid.dev/sso/outbound/saml/sp_unknown/slo'),
        'sp_unknown',
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'connection_not_found',
    )
  })

  it.each([
    'https://cookie.xid.dev/sso/saml/conn_other/slo',
    'https://auth.customer.example/sso/saml/conn_other/slo',
  ])('keeps the host-scoped tenant outside the instance issuer origin: %s', async (url) => {
    await expect(resolveSsoConnectionTenant(makeContext(url), 'conn_other')).resolves.toBe(
      COOKIE_TENANT,
    )
    expect(resolveTenantContextBySsoConnection).not.toHaveBeenCalled()
  })
})
