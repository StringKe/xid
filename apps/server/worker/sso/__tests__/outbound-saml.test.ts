// outbound-saml.ts 单元测试:出站 SSO session 跟踪、SLO 发起、SLO 接收端点。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'

const {
  trackOutboundSamlSessionMock,
  peekOutboundSamlSessionsForUserMock,
  resolveOutboundSamlSessionIndexMock,
  signLogoutRequestMock,
  signLogoutResponseMock,
  signSamlResponseMock,
  verifySamlLogoutRequestMock,
  verifySamlLogoutResponseMock,
  encodeRedirectBindingMessageMock,
  decodeSamlBindingPayloadMock,
  resolveSamlServiceProviderTenantMock,
  revokeSessionMock,
} = vi.hoisted(() => ({
  trackOutboundSamlSessionMock: vi.fn(),
  peekOutboundSamlSessionsForUserMock: vi.fn(),
  resolveOutboundSamlSessionIndexMock: vi.fn(),
  signLogoutRequestMock: vi.fn(),
  signLogoutResponseMock: vi.fn(),
  signSamlResponseMock: vi.fn(),
  verifySamlLogoutRequestMock: vi.fn(),
  verifySamlLogoutResponseMock: vi.fn(),
  encodeRedirectBindingMessageMock: vi.fn(),
  decodeSamlBindingPayloadMock: vi.fn(),
  resolveSamlServiceProviderTenantMock: vi.fn(),
  revokeSessionMock: vi.fn(),
}))

vi.mock('@xid-kit/saml', () => ({
  buildIdpMetadataXml: vi.fn(() => '<EntityDescriptor />'),
  decodeSamlBindingPayload: (...args: unknown[]) => decodeSamlBindingPayloadMock(...args),
  encodeRedirectBindingMessage: (...args: unknown[]) => encodeRedirectBindingMessageMock(...args),
  signLogoutRequest: (...args: unknown[]) => signLogoutRequestMock(...args),
  signLogoutResponse: (...args: unknown[]) => signLogoutResponseMock(...args),
  signSamlResponse: (...args: unknown[]) => signSamlResponseMock(...args),
  verifySamlLogoutRequest: (...args: unknown[]) => verifySamlLogoutRequestMock(...args),
  verifySamlLogoutResponse: (...args: unknown[]) => verifySamlLogoutResponseMock(...args),
}))

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return {
    ...actual,
    envelopeDecrypt: vi.fn().mockResolvedValue(new Uint8Array(32)),
    toBufferSource: (b: Uint8Array) => b,
  }
})

vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  subtle: {
    ...globalThis.crypto.subtle,
    importKey: vi.fn().mockResolvedValue({} as CryptoKey),
  },
})

vi.mock('../saml-do', () => ({
  trackOutboundSamlSession: (...args: unknown[]) => trackOutboundSamlSessionMock(...args),
  peekOutboundSamlSessionsForUser: (...args: unknown[]) =>
    peekOutboundSamlSessionsForUserMock(...args),
  resolveOutboundSamlSessionIndex: (...args: unknown[]) =>
    resolveOutboundSamlSessionIndexMock(...args),
}))

vi.mock('../tenant', () => ({
  resolveSamlServiceProviderTenant: (...args: unknown[]) =>
    resolveSamlServiceProviderTenantMock(...args),
  withTenant: async (_c: unknown, _tenant: unknown, fn: () => Promise<unknown>) => fn(),
}))

vi.mock('../../lib/session', () => ({
  revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
}))

const spFindOne = vi.fn()
const certFindOne = vi.fn()
const userFindOne = vi.fn()
const emailFindOne = vi.fn()
const membershipFindOne = vi.fn()
const sessionFindOne = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    samlServiceProviders: { findOne: spFindOne },
    certStore: { findOne: certFindOne },
    users: { findOne: userFindOne },
    userEmails: { findOne: emailFindOne },
    memberships: { findOne: membershipFindOne },
    sessions: { findOne: sessionFindOne },
  })),
  schema: {
    samlServiceProviders: { id: 'id' },
    certStore: { id: 'id', usage: 'usage', status: 'status' },
    users: { id: 'id', status: 'status' },
    userEmails: { id: 'id', userId: 'userId' },
    memberships: { userId: 'userId', orgId: 'orgId', status: 'status' },
    sessions: { id: 'id' },
  },
}))

import { initiateOutboundSamlLogout, registerOutboundSamlRoutes } from '../outbound-saml'

const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
  }
  return c.json({ code: 'server_error' }, 500)
}

const SP = {
  id: 'sp_1',
  tenantId: 'tenant_1',
  spEntityId: 'https://saas.example.com/saml',
  acsUrl: 'https://saas.example.com/acs',
  sloUrl: 'https://saas.example.com/slo',
  sloBinding: 'redirect',
  spCertificates: ['SP_CERT'],
  attributeMapping: {},
  nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
  idpSigningCertId: 'cert_1',
}

const CERT = {
  id: 'cert_1',
  certificate: 'CERT_B64',
  privateKeyIv: new Uint8Array(12),
  privateKeyCiphertext: new Uint8Array(32),
  privateKeyTag: new Uint8Array(16),
  kekVersion: 1,
  usage: 'saml_idp_signing',
  status: 'active',
}

const ENV = {
  DB: {},
  KEK: btoa('test-kek-32-bytes-padding!!!!'),
  AUDIT_QUEUE: { send: vi.fn() },
} as unknown as Env

function makeApp(session?: SessionData) {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId: 'tenant_1',
      issuer: 'https://acme.xid.dev',
      rpId: 'acme.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    })
    if (session) c.set('session', session)
    await next()
  })
  registerOutboundSamlRoutes(app)
  return app
}

function makeContext(session: SessionData) {
  return {
    env: ENV,
    get: (key: string) => {
      if (key === 'tenant') {
        return {
          tenantId: 'tenant_1',
          issuer: 'https://acme.xid.dev',
          rpId: 'acme.xid.dev',
          signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
          policy: {},
        }
      }
      if (key === 'session') return session
      return undefined
    },
    req: { raw: new Request('https://acme.xid.dev') },
  } as unknown as Parameters<typeof initiateOutboundSamlLogout>[0]
}

describe('outbound SAML SLO', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveSamlServiceProviderTenantMock.mockResolvedValue({
      tenantId: 'tenant_1',
      issuer: 'https://acme.xid.dev',
      rpId: 'acme.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    })
    spFindOne.mockResolvedValue(SP)
    certFindOne.mockResolvedValue(CERT)
    decodeSamlBindingPayloadMock.mockResolvedValue({ ok: true, value: '<samlp:LogoutRequest/>' })
    verifySamlLogoutRequestMock.mockResolvedValue({
      ok: true,
      value: { requestId: '_req_1', issuer: SP.spEntityId, sessionIndex: 'sess_1' },
    })
    resolveOutboundSamlSessionIndexMock.mockResolvedValue({
      userId: 'user_1',
      sessionId: 'sess_1',
    })
    signLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: { xml: '<LogoutResponse/>', samlMessage: btoa('<LogoutResponse/>') },
    })
    sessionFindOne.mockResolvedValue({
      id: 'sess_1',
      userId: 'user_1',
      status: 'active',
      activeOrgId: null,
      authenticatedAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rememberMe: true,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
    })
    signLogoutRequestMock.mockResolvedValue({
      ok: true,
      value: { xml: '<LogoutRequest/>', samlMessage: btoa('<LogoutRequest/>') },
    })
    encodeRedirectBindingMessageMock.mockResolvedValue('encoded-request')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  })

  it('trackOutboundSamlSession called during SSO with session TTL', async () => {
    userFindOne.mockResolvedValue({ id: 'user_1', status: 'active', primaryEmailId: 'email_1' })
    emailFindOne.mockResolvedValue({ email: 'user@example.com' })
    signSamlResponseMock.mockResolvedValue({
      ok: true,
      value: { samlResponse: btoa('<Response/>') },
    })
    const session: SessionData = {
      sessionId: 'sess_1',
      userId: 'user_1',
      status: 'active',
      activeOrgId: null,
      authenticatedAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      rememberMe: true,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
    }
    const res = await makeApp(session).request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/sso',
      {},
      ENV,
    )
    expect(res.status).toBe(200)
    expect(trackOutboundSamlSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: 'sp_1', sessionIndex: 'sess_1' }),
      expect.any(Number),
    )
    const ttlArg = trackOutboundSamlSessionMock.mock.calls[0]?.[2] as number
    expect(ttlArg).toBeGreaterThan(24 * 60 * 60 * 1000)
  })

  it('initiateOutboundSamlLogout sends redirect GET to slo_url', async () => {
    peekOutboundSamlSessionsForUserMock.mockResolvedValue([
      {
        appId: 'sp_1',
        sessionIndex: 'sess_1',
        userId: 'user_1',
        sessionId: 'sess_1',
        nameId: 'user@example.com',
        nameIdFormat: SP.nameIdFormat,
      },
    ])
    const session: SessionData = {
      sessionId: 'sess_1',
      userId: 'user_1',
      status: 'active',
      activeOrgId: null,
      authenticatedAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rememberMe: true,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
    }
    await initiateOutboundSamlLogout(makeContext(session), session)
    expect(signLogoutRequestMock).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://saas.example.com/slo'),
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('POST /slo parses SP LogoutRequest and returns LogoutResponse', async () => {
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )
    expect(res.status).toBe(200)
    expect(verifySamlLogoutRequestMock).toHaveBeenCalledOnce()
    expect(resolveOutboundSamlSessionIndexMock).toHaveBeenCalledWith(
      expect.anything(),
      'sp_1',
      'sess_1',
    )
    expect(revokeSessionMock).toHaveBeenCalledOnce()
  })

  it('POST /slo verifies LogoutResponse and revokes mapped session', async () => {
    decodeSamlBindingPayloadMock.mockResolvedValue({ ok: true, value: '<samlp:LogoutResponse/>' })
    verifySamlLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: {
        responseId: '_resp_1',
        issuer: SP.spEntityId,
        inResponseTo: '_req_1',
        statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
        sessionIndex: 'sess_1',
      },
    })
    const body = new URLSearchParams({ SAMLResponse: btoa('<LogoutResponse/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )
    expect(res.status).toBe(204)
    expect(verifySamlLogoutResponseMock).toHaveBeenCalledOnce()
    expect(resolveOutboundSamlSessionIndexMock).toHaveBeenCalled()
  })
})
