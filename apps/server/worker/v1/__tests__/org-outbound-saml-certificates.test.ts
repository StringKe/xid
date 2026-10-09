// 出站 SAML 签名证书路由:只有租户顶层组织能准备和切换证书,子组织与其他租户的组织被拒绝。
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'

const { activateMock, insertMock, requireOrgManagerMock } = vi.hoisted(() => ({
  activateMock: vi.fn(),
  insertMock: vi.fn(),
  requireOrgManagerMock: vi.fn(),
}))

vi.mock('../shared', () => ({
  requireApiKeyOrOrgManager: (...args: unknown[]) => requireOrgManagerMock(...args),
  requireOrg: vi.fn().mockResolvedValue({ id: 'tenant_a', allowOrgSelfService: true }),
}))
vi.mock('../org-self-service', () => ({ assertOrgSelfServiceEditable: vi.fn() }))
vi.mock('../org-shared', () => ({
  auditOrgMutation: vi.fn(),
  toIso: (value: Date | null) => value?.toISOString() ?? null,
}))
vi.mock('../../sso/outbound-saml-certificate-rotation', () => ({
  activateNextOutboundSamlSigningCertificate: (...args: unknown[]) => activateMock(...args),
  listOutboundSamlSigningCertificates: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../sso/signing-certificate', () => ({
  certificateCommonName: () => 'xid.test',
  insertOutboundSamlCertificate: (...args: unknown[]) => insertMock(...args),
}))

import { registerOrgOutboundSamlCertificateRoutes } from '../org-outbound-saml-certificates'

const errorHandler: ErrorHandler<XidHonoEnv> = (err, c) =>
  isAppError(err)
    ? c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
    : c.json({ code: 'server_error' }, 500)

function makeApp() {
  const app = new Hono<XidHonoEnv>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', { tenantId: 'tenant_a', issuer: 'https://xid.test' } as never)
    await next()
  })
  registerOrgOutboundSamlCertificateRoutes(app)
  return app
}

function post(path: string) {
  return makeApp().request(
    `https://xid.test/v1/organizations/${path}`,
    { method: 'POST' },
    {} as Env,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  requireOrgManagerMock.mockResolvedValue({ kind: 'api_key', apiKeyId: 'key_1', scopes: ['*'] })
  activateMock.mockResolvedValue({
    ok: true,
    value: { activatedId: 'cert_new', retiringId: 'cert_old' },
  })
})

describe('outbound SAML signing certificate routes', () => {
  it('lets the top-level organization switch to the next certificate', async () => {
    const res = await post('tenant_a/outbound-saml-signing-certificates/cert_new/activate')

    expect(res.status).toBe(200)
    expect(activateMock).toHaveBeenCalledWith(expect.anything(), 'cert_new')
  })

  it('rejects a switch requested through a child organization', async () => {
    const res = await post('org_child/outbound-saml-signing-certificates/cert_new/activate')

    expect(res.status).toBe(403)
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('rejects a switch requested for an organization of another tenant', async () => {
    requireOrgManagerMock.mockRejectedValue(new AppError('org_not_found', { httpStatus: 404 }))

    const res = await post('tenant_b/outbound-saml-signing-certificates/cert_new/activate')

    expect(res.status).toBe(404)
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('maps an unknown next certificate to 404 and a lost race to 409', async () => {
    activateMock.mockResolvedValueOnce({ ok: false, error: 'certificate_not_found' })
    activateMock.mockResolvedValueOnce({ ok: false, error: 'conflict' })

    const missing = await post('tenant_a/outbound-saml-signing-certificates/cert_x/activate')
    const raced = await post('tenant_a/outbound-saml-signing-certificates/cert_new/activate')

    expect([missing.status, raced.status]).toEqual([404, 409])
  })

  it('returns 409 when a next certificate already exists', async () => {
    insertMock.mockResolvedValue(null)

    const res = await post('tenant_a/outbound-saml-signing-certificates')

    expect(res.status).toBe(409)
    expect(insertMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant_a', status: 'next' }),
    )
  })
})
