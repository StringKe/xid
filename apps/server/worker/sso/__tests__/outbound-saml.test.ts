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
  resolveOutboundSamlSessionByNameIdMock,
  storeOutboundLogoutRequestContextMock,
  consumeOutboundLogoutRequestContextMock,
  isLogoutRequestReplayMock,
  releaseLogoutRequestReplayMock,
  restoreConsumedSamlSessionBindingsMock,
  buildLogoutRequestXmlMock,
  buildLogoutResponseXmlMock,
  signLogoutRequestMock,
  signLogoutResponseMock,
  signRedirectBindingRequestMock,
  signRedirectBindingResponseMock,
  signSamlResponseMock,
  verifySamlAuthnRequestMock,
  verifySamlLogoutRequestMock,
  verifySamlLogoutResponseMock,
  encodeRedirectBindingMessageMock,
  decodeSamlBindingPayloadMock,
  resolveSamlServiceProviderTenantMock,
  revokeSessionMock,
  sessionDoRevokeMock,
} = vi.hoisted(() => ({
  trackOutboundSamlSessionMock: vi.fn(),
  peekOutboundSamlSessionsForUserMock: vi.fn(),
  resolveOutboundSamlSessionIndexMock: vi.fn(),
  resolveOutboundSamlSessionByNameIdMock: vi.fn(),
  storeOutboundLogoutRequestContextMock: vi.fn(),
  consumeOutboundLogoutRequestContextMock: vi.fn(),
  isLogoutRequestReplayMock: vi.fn(),
  releaseLogoutRequestReplayMock: vi.fn(),
  restoreConsumedSamlSessionBindingsMock: vi.fn(),
  buildLogoutRequestXmlMock: vi.fn(),
  buildLogoutResponseXmlMock: vi.fn(),
  signLogoutRequestMock: vi.fn(),
  signLogoutResponseMock: vi.fn(),
  signRedirectBindingRequestMock: vi.fn(),
  signRedirectBindingResponseMock: vi.fn(),
  signSamlResponseMock: vi.fn(),
  verifySamlAuthnRequestMock: vi.fn(),
  verifySamlLogoutRequestMock: vi.fn(),
  verifySamlLogoutResponseMock: vi.fn(),
  encodeRedirectBindingMessageMock: vi.fn(),
  decodeSamlBindingPayloadMock: vi.fn(),
  resolveSamlServiceProviderTenantMock: vi.fn(),
  revokeSessionMock: vi.fn(),
  sessionDoRevokeMock: vi.fn(),
}))

vi.mock('@xid-kit/saml', () => ({
  buildIdpMetadataXml: vi.fn(() => '<EntityDescriptor />'),
  loadIdpVerifyKey: vi.fn().mockResolvedValue({
    ok: true,
    value: {
      publicKey: {} as CryptoKey,
      fingerprint: 'AA',
      notBefore: 0,
      notAfter: Date.now() + 24 * 60 * 60 * 1000,
    },
  }),
  buildLogoutRequestXml: (...args: unknown[]) => buildLogoutRequestXmlMock(...args),
  buildLogoutResponseXml: (...args: unknown[]) => buildLogoutResponseXmlMock(...args),
  decodeSamlBindingPayload: (...args: unknown[]) => decodeSamlBindingPayloadMock(...args),
  encodeRedirectBindingMessage: (...args: unknown[]) => encodeRedirectBindingMessageMock(...args),
  signLogoutRequest: (...args: unknown[]) => signLogoutRequestMock(...args),
  signLogoutResponse: (...args: unknown[]) => signLogoutResponseMock(...args),
  signRedirectBindingRequest: (...args: unknown[]) => signRedirectBindingRequestMock(...args),
  signRedirectBindingResponse: (...args: unknown[]) => signRedirectBindingResponseMock(...args),
  signSamlResponse: (...args: unknown[]) => signSamlResponseMock(...args),
  verifySamlAuthnRequest: (...args: unknown[]) => verifySamlAuthnRequestMock(...args),
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
  storeOutboundLogoutRequestContext: (...args: unknown[]) =>
    storeOutboundLogoutRequestContextMock(...args),
  consumeOutboundLogoutRequestContext: (...args: unknown[]) =>
    consumeOutboundLogoutRequestContextMock(...args),
  isLogoutRequestReplay: (...args: unknown[]) => isLogoutRequestReplayMock(...args),
  releaseLogoutRequestReplay: (...args: unknown[]) => releaseLogoutRequestReplayMock(...args),
}))
vi.mock('../saml-session-bindings', () => ({
  resolveOutboundSamlSessionByNameId: (...args: unknown[]) =>
    resolveOutboundSamlSessionByNameIdMock(...args),
  restoreConsumedSamlSessionBindings: (...args: unknown[]) =>
    restoreConsumedSamlSessionBindingsMock(...args),
}))

vi.mock('../tenant', () => ({
  resolveSamlServiceProviderTenant: (...args: unknown[]) =>
    resolveSamlServiceProviderTenantMock(...args),
  withTenant: async (_c: unknown, _tenant: unknown, fn: () => Promise<unknown>) => fn(),
}))

vi.mock('../../lib/session', () => ({
  revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
  sessionDoRevoke: (...args: unknown[]) => sessionDoRevokeMock(...args),
}))

const spFindOne = vi.fn()
const certFindOne = vi.fn()
const userFindOne = vi.fn()
const emailFindOne = vi.fn()
const membershipFindOne = vi.fn()
const sessionFindOne = vi.fn()
const sessionUpdate = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    samlServiceProviders: { findOne: spFindOne },
    certStore: { findOne: certFindOne },
    users: { findOne: userFindOne },
    userEmails: { findOne: emailFindOne },
    memberships: { findOne: membershipFindOne },
    sessions: { findOne: sessionFindOne, update: sessionUpdate },
  })),
  schema: {
    samlServiceProviders: { id: 'id' },
    certStore: { id: 'id', usage: 'usage', status: 'status' },
    users: { id: 'id', status: 'status' },
    userEmails: { id: 'id', userId: 'userId' },
    memberships: { userId: 'userId', orgId: 'orgId', status: 'status' },
    sessions: { id: 'id', userId: 'userId', status: 'status' },
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
  ENVIRONMENT: 'test',
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
      value: {
        requestId: '_req_1',
        issuer: SP.spEntityId,
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: ['sess_1'],
      },
    })
    resolveOutboundSamlSessionIndexMock.mockResolvedValue({
      userId: 'user_1',
      sessionId: 'sess_1',
    })
    resolveOutboundSamlSessionByNameIdMock.mockResolvedValue([])
    storeOutboundLogoutRequestContextMock.mockResolvedValue(undefined)
    consumeOutboundLogoutRequestContextMock.mockResolvedValue({
      tenantId: 'tenant_1',
      appId: 'sp_1',
      sessionIndex: 'sess_1',
      relayState: 'https://acme.xid.dev/sign-in',
      returnTo: 'https://acme.xid.dev/sign-in',
      remaining: [],
    })
    isLogoutRequestReplayMock.mockResolvedValue(false)
    releaseLogoutRequestReplayMock.mockResolvedValue(undefined)
    restoreConsumedSamlSessionBindingsMock.mockResolvedValue(undefined)
    sessionDoRevokeMock.mockResolvedValue(undefined)
    sessionUpdate.mockResolvedValue([{ id: 'sess_1', status: 'revoked' }])
    buildLogoutRequestXmlMock.mockReturnValue({
      requestId: '_req_1',
      xml: '<LogoutRequest/>',
    })
    buildLogoutResponseXmlMock.mockReturnValue({
      responseId: '_resp_1',
      xml: '<LogoutResponse/>',
    })
    signLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: {
        messageId: '_resp_1',
        xml: '<LogoutResponse/>',
        samlMessage: btoa('<LogoutResponse/>'),
      },
    })
    signRedirectBindingRequestMock.mockResolvedValue({
      ok: true,
      value: {
        sigAlg: 'rsa-sha256',
        signature: 'request-signature',
        query:
          'SAMLRequest=encoded-request&RelayState=https%3A%2F%2Facme.xid.dev%2Fsign-in&SigAlg=rsa-sha256&Signature=request-signature',
      },
    })
    signRedirectBindingResponseMock.mockResolvedValue({
      ok: true,
      value: {
        sigAlg: 'rsa-sha256',
        signature: 'response-signature',
        query: 'SAMLResponse=encoded-request&SigAlg=rsa-sha256&Signature=response-signature',
      },
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
      value: {
        messageId: '_req_1',
        xml: '<LogoutRequest/>',
        samlMessage: btoa('<LogoutRequest/>'),
      },
    })
    verifySamlAuthnRequestMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_authn_req_1',
        issuer: SP.spEntityId,
        destination: 'https://acme.xid.dev/sso/outbound/saml/sp_1/sso',
        acsUrl: SP.acsUrl,
        signatureVerified: false,
      },
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

  it('preserves a Redirect AuthnRequest across the sign-in redirect', async () => {
    const query = new URLSearchParams({
      SAMLRequest: 'encoded-request',
      RelayState: 'relay-state',
    })
    const res = await makeApp().request(
      `https://acme.xid.dev/sso/outbound/saml/sp_1/sso?${query}`,
      {},
      ENV,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('continue')).toBe(
      `/sso/outbound/saml/sp_1/sso?${query.toString()}`,
    )
  })

  it('validates a Redirect AuthnRequest and binds the signed response to its ID', async () => {
    userFindOne.mockResolvedValue({ id: 'user_1', status: 'active', primaryEmailId: 'email_1' })
    emailFindOne.mockResolvedValue({ email: 'user@example.com' })
    decodeSamlBindingPayloadMock.mockResolvedValue({
      ok: true,
      value: '<samlp:AuthnRequest/>',
    })
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
      expiresAt: new Date(Date.now() + 60_000),
      rememberMe: true,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
    }
    const query = new URLSearchParams({
      SAMLRequest: 'encoded-request',
      RelayState: 'relay-state',
    })
    const res = await makeApp(session).request(
      `https://acme.xid.dev/sso/outbound/saml/sp_1/sso?${query}`,
      {},
      ENV,
    )

    expect(res.status).toBe(200)
    expect(decodeSamlBindingPayloadMock).toHaveBeenCalledWith('encoded-request', 'redirect')
    expect(verifySamlAuthnRequestMock).toHaveBeenCalledWith('<samlp:AuthnRequest/>', {
      expectedIssuer: SP.spEntityId,
      expectedDestination: 'https://acme.xid.dev/sso/outbound/saml/sp_1/sso',
      expectedAcsUrl: SP.acsUrl,
      spCertificatesB64: SP.spCertificates,
      requireSignature: false,
    })
    expect(signSamlResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ inResponseTo: '_authn_req_1' }),
      expect.anything(),
    )
    expect(await res.text()).toContain('value="relay-state"')
  })

  it('passes Redirect signature material to AuthnRequest verification', async () => {
    userFindOne.mockResolvedValue({ id: 'user_1', status: 'active', primaryEmailId: 'email_1' })
    emailFindOne.mockResolvedValue({ email: 'user@example.com' })
    decodeSamlBindingPayloadMock.mockResolvedValue({
      ok: true,
      value: '<samlp:AuthnRequest/>',
    })
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
      expiresAt: new Date(Date.now() + 60_000),
      rememberMe: true,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
    }
    const query = new URLSearchParams({
      SAMLRequest: 'encoded-request',
      RelayState: 'relay-state',
      Signature: 'signature',
      SigAlg: 'rsa-sha256',
    })
    const res = await makeApp(session).request(
      `https://acme.xid.dev/sso/outbound/saml/sp_1/sso?${query}`,
      {},
      ENV,
    )

    expect(res.status).toBe(200)
    expect(verifySamlAuthnRequestMock).toHaveBeenCalledWith(
      '<samlp:AuthnRequest/>',
      expect.objectContaining({
        redirectSignature: {
          samlRequestEncoded: 'encoded-request',
          relayState: 'relay-state',
          signature: 'signature',
          sigAlg: 'rsa-sha256',
          wireEncoded: {
            samlMessage: 'encoded-request',
            relayState: 'relay-state',
            sigAlg: 'rsa-sha256',
          },
        },
      }),
    )
  })

  it('rejects an invalid AuthnRequest before response signing', async () => {
    decodeSamlBindingPayloadMock.mockResolvedValue({
      ok: true,
      value: '<samlp:AuthnRequest/>',
    })
    verifySamlAuthnRequestMock.mockResolvedValue({
      ok: false,
      error: { code: 'issuer_mismatch', reason: 'mismatch' },
    })
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
    const res = await makeApp(session).request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/sso?SAMLRequest=encoded-request',
      {},
      ENV,
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ code: 'malformed_request' })
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('rejects incomplete Redirect signature parameters', async () => {
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
    const res = await makeApp(session).request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/sso?SAMLRequest=encoded-request&Signature=only',
      {},
      ENV,
    )

    expect(res.status).toBe(400)
    expect(decodeSamlBindingPayloadMock).not.toHaveBeenCalled()
    expect(verifySamlAuthnRequestMock).not.toHaveBeenCalled()
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('initiateOutboundSamlLogout returns a browser Redirect action', async () => {
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
    const action = await initiateOutboundSamlLogout(makeContext(session), session)
    expect(signLogoutRequestMock).not.toHaveBeenCalled()
    expect(signRedirectBindingRequestMock).toHaveBeenCalledWith(
      'encoded-request',
      'https://acme.xid.dev/sign-in',
      expect.anything(),
    )
    expect(storeOutboundLogoutRequestContextMock).toHaveBeenCalledWith(expect.anything(), {
      appId: 'sp_1',
      requestId: '_req_1',
      sessionIndex: 'sess_1',
      relayState: 'https://acme.xid.dev/sign-in',
      returnTo: 'https://acme.xid.dev/sign-in',
      remaining: [],
    })
    expect(action).toEqual({
      binding: 'redirect',
      url: 'https://saas.example.com/slo?SAMLRequest=encoded-request&RelayState=https%3A%2F%2Facme.xid.dev%2Fsign-in&SigAlg=rsa-sha256&Signature=request-signature',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('invalid stored ACS URL fails closed at runtime', async () => {
    spFindOne.mockResolvedValue({
      ...SP,
      acsUrl: 'https://169.254.169.254/acs',
    })

    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/metadata',
      {},
      ENV,
    )

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ code: 'connection_not_found' })
    expect(certFindOne).not.toHaveBeenCalled()
  })

  it('allows loopback ACS only in development or test', async () => {
    spFindOne.mockResolvedValue({
      ...SP,
      acsUrl: 'http://127.0.0.1:8787/saml/acs',
    })

    const local = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/metadata',
      {},
      ENV,
    )
    const production = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/metadata',
      {},
      { ...ENV, ENVIRONMENT: 'production' } as Env,
    )

    expect(local.status).toBe(200)
    expect(production.status).toBe(404)
    await expect(production.json()).resolves.toEqual({ code: 'connection_not_found' })
  })

  it('invalid stored SLO URL does not block best-effort sign-out or fetch', async () => {
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
    spFindOne.mockResolvedValue({
      ...SP,
      sloUrl: 'https://127.0.0.1/slo',
    })
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

    await expect(initiateOutboundSamlLogout(makeContext(session), session)).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(signLogoutRequestMock).not.toHaveBeenCalled()
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
    expect(isLogoutRequestReplayMock).toHaveBeenCalledWith(expect.anything(), {
      direction: 'outbound',
      scopeId: 'sp_1',
      requestId: '_req_1',
      validUntil: expect.any(Number),
    })
    expect(revokeSessionMock).toHaveBeenCalledOnce()
  })

  it('consumes and revokes every SessionIndex in an SP LogoutRequest', async () => {
    verifySamlLogoutRequestMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_req_multi',
        issuer: SP.spEntityId,
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: ['sess_1', 'sess_2'],
      },
    })
    resolveOutboundSamlSessionIndexMock
      .mockResolvedValueOnce({ userId: 'user_1', sessionId: 'sess_1' })
      .mockResolvedValueOnce({ userId: 'user_1', sessionId: 'sess_2' })
    sessionFindOne
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce({
        id: 'sess_2',
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
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(200)
    expect(resolveOutboundSamlSessionIndexMock.mock.calls).toEqual([
      [expect.anything(), 'sp_1', 'sess_1'],
      [expect.anything(), 'sp_1', 'sess_2'],
    ])
    expect(revokeSessionMock).toHaveBeenCalledTimes(2)
  })

  it('attempts every mapping and stays fail-closed when the primary revocation path fails', async () => {
    verifySamlLogoutRequestMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_req_partial_failure',
        issuer: SP.spEntityId,
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: ['sess_1', 'sess_2'],
      },
    })
    resolveOutboundSamlSessionIndexMock
      .mockResolvedValueOnce({ userId: 'user_1', sessionId: 'sess_1' })
      .mockResolvedValueOnce({ userId: 'user_1', sessionId: 'sess_1' })
    revokeSessionMock
      .mockRejectedValueOnce(new Error('session revocation unavailable'))
      .mockResolvedValueOnce(undefined)
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(200)
    expect(resolveOutboundSamlSessionIndexMock).toHaveBeenCalledTimes(2)
    expect(revokeSessionMock).toHaveBeenCalledTimes(2)
    expect(sessionDoRevokeMock).toHaveBeenCalledOnce()
    expect(sessionUpdate).toHaveBeenCalledOnce()
    expect(releaseLogoutRequestReplayMock).not.toHaveBeenCalled()
  })

  it('restores exact mappings and releases the replay claim when both revoke stores fail', async () => {
    const consumedBinding = {
      bindingId: 'binding_retry',
      consumedAt: 1_000,
      userId: 'user_1',
      sessionId: 'sess_1',
    }
    resolveOutboundSamlSessionIndexMock.mockResolvedValue(consumedBinding)
    revokeSessionMock
      .mockRejectedValueOnce(new Error('primary revocation failed'))
      .mockResolvedValue(undefined)
    sessionDoRevokeMock
      .mockRejectedValueOnce(new Error('SessionDO unavailable'))
      .mockResolvedValue(undefined)
    sessionUpdate
      .mockRejectedValueOnce(new Error('D1 unavailable'))
      .mockResolvedValue([{ id: 'sess_1', status: 'revoked' }])
    const body = () => new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const failed = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )
    const retried = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )

    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ code: 'server_error' })
    expect(retried.status).toBe(200)
    expect(restoreConsumedSamlSessionBindingsMock).toHaveBeenCalledWith(expect.anything(), {
      direction: 'outbound',
      scopeId: 'sp_1',
      bindings: [consumedBinding],
    })
    expect(releaseLogoutRequestReplayMock).toHaveBeenCalledOnce()
    expect(restoreConsumedSamlSessionBindingsMock.mock.invocationCallOrder[0]).toBeLessThan(
      releaseLogoutRequestReplayMock.mock.invocationCallOrder[0]!,
    )
    expect(resolveOutboundSamlSessionIndexMock).toHaveBeenCalledTimes(2)
  })

  it('consumes and revokes every NameID mapping when SessionIndex is absent', async () => {
    verifySamlLogoutRequestMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_req_name_id',
        issuer: SP.spEntityId,
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: [],
        nameId: 'user@example.com',
      },
    })
    resolveOutboundSamlSessionByNameIdMock.mockResolvedValue([
      { userId: 'user_1', sessionId: 'sess_1' },
      { userId: 'user_1', sessionId: 'sess_2' },
    ])
    sessionFindOne
      .mockResolvedValueOnce({
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
      .mockResolvedValueOnce({
        id: 'sess_2',
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
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(200)
    expect(resolveOutboundSamlSessionIndexMock).not.toHaveBeenCalled()
    expect(resolveOutboundSamlSessionByNameIdMock).toHaveBeenCalledWith(
      expect.anything(),
      'sp_1',
      'user@example.com',
    )
    expect(revokeSessionMock).toHaveBeenCalledTimes(2)
  })

  it('releases the replay claim when NameID mapping consumption fails so the request can retry', async () => {
    verifySamlLogoutRequestMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_req_name_id_retry',
        issuer: SP.spEntityId,
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: [],
        nameId: 'user@example.com',
      },
    })
    resolveOutboundSamlSessionByNameIdMock
      .mockRejectedValueOnce(new Error('D1 UPDATE RETURNING unavailable'))
      .mockResolvedValueOnce([
        {
          bindingId: 'binding_name_id_retry',
          consumedAt: 1_000,
          userId: 'user_1',
          sessionId: 'sess_1',
        },
      ])
    let replayClaimed = false
    isLogoutRequestReplayMock.mockImplementation(async () => {
      if (replayClaimed) return true
      replayClaimed = true
      return false
    })
    releaseLogoutRequestReplayMock.mockImplementation(async () => {
      replayClaimed = false
    })
    const body = () => new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const failed = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )
    const retried = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )

    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ code: 'server_error' })
    expect(retried.status).toBe(200)
    expect(resolveOutboundSamlSessionByNameIdMock).toHaveBeenCalledTimes(2)
    expect(restoreConsumedSamlSessionBindingsMock).toHaveBeenCalledWith(expect.anything(), {
      direction: 'outbound',
      scopeId: 'sp_1',
      bindings: [],
    })
    expect(releaseLogoutRequestReplayMock).toHaveBeenCalledOnce()
    expect(revokeSessionMock).toHaveBeenCalledOnce()
  })

  it('rejects a replayed LogoutRequest before consuming another session binding', async () => {
    isLogoutRequestReplayMock.mockResolvedValue(true)
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(403)
    expect(resolveOutboundSamlSessionIndexMock).not.toHaveBeenCalled()
    expect(revokeSessionMock).not.toHaveBeenCalled()
    expect(releaseLogoutRequestReplayMock).not.toHaveBeenCalled()
  })

  it('POST /slo verifies LogoutResponse, revokes the mapped session, and completes the chain', async () => {
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
    const body = new URLSearchParams({
      SAMLResponse: btoa('<LogoutResponse/>'),
      RelayState: 'https://acme.xid.dev/sign-in',
    })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://acme.xid.dev/sign-in')
    expect(verifySamlLogoutResponseMock).toHaveBeenCalledWith(
      '<samlp:LogoutResponse/>',
      expect.objectContaining({
        spCertificatesB64: SP.spCertificates,
        requireSignature: true,
      }),
    )
    expect(consumeOutboundLogoutRequestContextMock).toHaveBeenCalledWith(
      expect.anything(),
      'sp_1',
      '_req_1',
      'https://acme.xid.dev/sign-in',
    )
    expect(resolveOutboundSamlSessionIndexMock).toHaveBeenCalledWith(
      expect.anything(),
      'sp_1',
      'sess_1',
    )
  })

  it('continues the browser SLO chain with the next registered SP', async () => {
    const nextSp = {
      ...SP,
      id: 'sp_2',
      spEntityId: 'https://next.example.com/saml',
      sloUrl: 'https://next.example.com/slo',
    }
    spFindOne.mockResolvedValueOnce(SP).mockResolvedValueOnce(nextSp)
    decodeSamlBindingPayloadMock.mockResolvedValue({ ok: true, value: '<samlp:LogoutResponse/>' })
    verifySamlLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: {
        responseId: '_resp_1',
        issuer: SP.spEntityId,
        inResponseTo: '_req_1',
        statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      },
    })
    consumeOutboundLogoutRequestContextMock.mockResolvedValue({
      tenantId: 'tenant_1',
      appId: 'sp_1',
      sessionIndex: 'sess_1',
      relayState: 'https://acme.xid.dev/sign-in',
      returnTo: 'https://acme.xid.dev/sign-in',
      remaining: [
        {
          appId: 'sp_2',
          sessionIndex: 'sess_2',
          nameId: 'user@example.com',
          nameIdFormat: SP.nameIdFormat,
        },
      ],
    })
    const body = new URLSearchParams({
      SAMLResponse: btoa('<LogoutResponse/>'),
      RelayState: 'https://acme.xid.dev/sign-in',
    })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('https://next.example.com/slo?SAMLRequest=')
    expect(storeOutboundLogoutRequestContextMock).toHaveBeenCalledWith(expect.anything(), {
      appId: 'sp_2',
      requestId: '_req_1',
      sessionIndex: 'sess_2',
      relayState: 'https://acme.xid.dev/sign-in',
      returnTo: 'https://acme.xid.dev/sign-in',
      remaining: [],
    })
  })

  it('audits a signed non-Success response and continues the remaining browser chain', async () => {
    const nextSp = {
      ...SP,
      id: 'sp_2',
      spEntityId: 'https://next.example.com/saml',
      sloUrl: 'https://next.example.com/slo',
    }
    spFindOne.mockResolvedValueOnce(SP).mockResolvedValueOnce(nextSp)
    decodeSamlBindingPayloadMock.mockResolvedValue({ ok: true, value: '<samlp:LogoutResponse/>' })
    verifySamlLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: {
        responseId: '_resp_failed',
        issuer: SP.spEntityId,
        inResponseTo: '_req_1',
        statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
      },
    })
    consumeOutboundLogoutRequestContextMock.mockResolvedValue({
      tenantId: 'tenant_1',
      appId: 'sp_1',
      sessionIndex: 'sess_1',
      relayState: 'https://acme.xid.dev/sign-in',
      returnTo: 'https://acme.xid.dev/sign-in',
      remaining: [
        {
          appId: 'sp_2',
          sessionIndex: 'sess_2',
          nameId: 'user@example.com',
          nameIdFormat: SP.nameIdFormat,
        },
      ],
    })
    const body = new URLSearchParams({
      SAMLResponse: btoa('<LogoutResponse/>'),
      RelayState: 'https://acme.xid.dev/sign-in',
    })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('https://next.example.com/slo?SAMLRequest=')
    expect(resolveOutboundSamlSessionIndexMock).not.toHaveBeenCalled()
    expect(revokeSessionMock).not.toHaveBeenCalled()
    expect(storeOutboundLogoutRequestContextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: 'sp_2', remaining: [] }),
    )
    expect(ENV.AUDIT_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'saml.slo_failed',
        payload: expect.objectContaining({
          kind: 'logout_response',
          statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
        }),
      }),
    )
  })

  it('rejects a LogoutResponse without RelayState before consuming chain state', async () => {
    decodeSamlBindingPayloadMock.mockResolvedValue({ ok: true, value: '<samlp:LogoutResponse/>' })
    verifySamlLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: {
        responseId: '_resp_1',
        issuer: SP.spEntityId,
        inResponseTo: '_req_1',
        statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      },
    })
    const body = new URLSearchParams({ SAMLResponse: btoa('<LogoutResponse/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(400)
    expect(consumeOutboundLogoutRequestContextMock).not.toHaveBeenCalled()
    expect(resolveOutboundSamlSessionIndexMock).not.toHaveBeenCalled()
  })

  it('verifies detached Redirect LogoutResponse material and rejects unknown request state', async () => {
    decodeSamlBindingPayloadMock.mockResolvedValue({ ok: true, value: '<samlp:LogoutResponse/>' })
    verifySamlLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: {
        responseId: '_resp_1',
        issuer: SP.spEntityId,
        inResponseTo: '_unknown',
        statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      },
    })
    consumeOutboundLogoutRequestContextMock.mockResolvedValue(null)
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo?SAMLResponse=encoded%2Fresponse&RelayState=state%20value&SigAlg=rsa%2dsha256&Signature=response-signature',
      {},
      ENV,
    )

    expect(res.status).toBe(400)
    expect(verifySamlLogoutResponseMock).toHaveBeenCalledWith(
      '<samlp:LogoutResponse/>',
      expect.objectContaining({
        requireSignature: true,
        redirectSignature: {
          samlResponseEncoded: 'encoded/response',
          relayState: 'state value',
          sigAlg: 'rsa-sha256',
          signature: 'response-signature',
          wireEncoded: {
            samlMessage: 'encoded%2Fresponse',
            relayState: 'state%20value',
            sigAlg: 'rsa%2dsha256',
          },
        },
      }),
    )
    expect(resolveOutboundSamlSessionIndexMock).not.toHaveBeenCalled()
  })

  it.each(['SAMLRequest', 'SAMLResponse', 'RelayState'])(
    'rejects duplicate HTTP-POST %s fields before decoding',
    async (field) => {
      const body =
        field === 'SAMLRequest'
          ? new URLSearchParams({
              SAMLRequest: btoa('<LogoutRequest/>'),
              RelayState: 'https://acme.xid.dev/sign-in',
            })
          : new URLSearchParams({
              SAMLResponse: btoa('<LogoutResponse/>'),
              RelayState: 'https://acme.xid.dev/sign-in',
            })
      body.append(
        field,
        field === 'SAMLRequest'
          ? btoa('<LogoutRequest/>')
          : field === 'SAMLResponse'
            ? btoa('<OtherLogoutResponse/>')
            : '/console',
      )
      const res = await makeApp().request(
        'https://acme.xid.dev/sso/outbound/saml/sp_1/slo',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        },
        ENV,
      )

      expect(res.status).toBe(400)
      expect(decodeSamlBindingPayloadMock).not.toHaveBeenCalled()
    },
  )

  it('rejects ambiguous SLO messages and duplicate signed query parameters', async () => {
    const both = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo?SAMLRequest=a&SAMLResponse=b&SigAlg=alg&Signature=sig',
      {},
      ENV,
    )
    const duplicate = await makeApp().request(
      'https://acme.xid.dev/sso/outbound/saml/sp_1/slo?SAMLRequest=a&SAMLRequest=b&SigAlg=alg&Signature=sig',
      {},
      ENV,
    )

    expect(both.status).toBe(400)
    expect(duplicate.status).toBe(400)
    expect(decodeSamlBindingPayloadMock).not.toHaveBeenCalled()
  })
})
