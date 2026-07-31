// saml.ts ACS 端点流程单测:验签成功 -> JIT -> session -> 回跳 RelayState;及各错误分支 HTTP 状态(8.8)。
// mock @xid-kit/saml(verifySamlResponse)与 connection/JIT/DO/session,聚焦 router 编排与错误码映射。

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  verifyMock,
  verifyLogoutMock,
  buildLogoutResponseXmlMock,
  signLogoutResponseMock,
  signRedirectBindingResponseMock,
  decodeSamlBindingPayloadMock,
  resolveConnectionMock,
  loadSpDecryptKeyMock,
  loadSpSigningKeyMock,
  provisionUserMock,
  issueSessionMock,
  revokeSessionMock,
  sessionDoRevokeMock,
  sessionUpdateMock,
  consumeAuthnRequestIdMock,
  isAssertionReplayMock,
  isLogoutRequestReplayMock,
  releaseLogoutRequestReplayMock,
  restoreConsumedSamlSessionBindingsMock,
  resolveInboundSamlSessionByNameIdMock,
  resolveInboundSamlSessionIndexMock,
  storeInboundSamlSessionIndexMock,
  resolveTenantContextBySsoConnectionMock,
  resolveTenantContextByApplicationClientIdMock,
  buildSpMetadataMock,
  redirectToIdpMock,
} = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  verifyLogoutMock: vi.fn(),
  buildLogoutResponseXmlMock: vi.fn(),
  signLogoutResponseMock: vi.fn(),
  signRedirectBindingResponseMock: vi.fn(),
  decodeSamlBindingPayloadMock: vi.fn(),
  resolveConnectionMock: vi.fn(),
  loadSpDecryptKeyMock: vi.fn(),
  loadSpSigningKeyMock: vi.fn(),
  provisionUserMock: vi.fn(),
  issueSessionMock: vi.fn(),
  revokeSessionMock: vi.fn(),
  sessionDoRevokeMock: vi.fn(),
  sessionUpdateMock: vi.fn(),
  consumeAuthnRequestIdMock: vi.fn(),
  isAssertionReplayMock: vi.fn(),
  isLogoutRequestReplayMock: vi.fn(),
  releaseLogoutRequestReplayMock: vi.fn(),
  restoreConsumedSamlSessionBindingsMock: vi.fn(),
  resolveInboundSamlSessionByNameIdMock: vi.fn(),
  resolveInboundSamlSessionIndexMock: vi.fn(),
  storeInboundSamlSessionIndexMock: vi.fn(),
  resolveTenantContextBySsoConnectionMock: vi.fn(),
  resolveTenantContextByApplicationClientIdMock: vi.fn(),
  buildSpMetadataMock: vi.fn(),
  redirectToIdpMock: vi.fn(),
}))

vi.mock('@xid-kit/saml', () => ({
  setSamlEngine: vi.fn(),
  // ACS 先 base64-decode SAMLResponse 再 verify;mock 用真实 base64 decode(合法 base64 -> ok)。
  decodeBase64Xml: (s: string) => {
    try {
      return { ok: true, value: atob(s) }
    } catch {
      return { ok: false, error: { code: 'malformed_request', reason: 'bad base64' } }
    }
  },
  decodeSamlBindingPayload: (...args: unknown[]) => decodeSamlBindingPayloadMock(...args),
  encodeRedirectBindingMessage: vi.fn().mockResolvedValue('encoded-logout-response'),
  buildLogoutResponseXml: (...args: unknown[]) => buildLogoutResponseXmlMock(...args),
  verifySamlResponse: (...args: unknown[]) => verifyMock(...args),
  verifySamlLogoutRequest: (...args: unknown[]) => verifyLogoutMock(...args),
  signLogoutResponse: (...args: unknown[]) => signLogoutResponseMock(...args),
  signRedirectBindingResponse: (...args: unknown[]) => signRedirectBindingResponseMock(...args),
}))
vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})
vi.mock('../saml-connection', () => ({
  resolveConnection: (...a: unknown[]) => resolveConnectionMock(...a),
  loadSpDecryptKey: (...a: unknown[]) => loadSpDecryptKeyMock(...a),
  loadSpSigningKey: (...a: unknown[]) => loadSpSigningKeyMock(...a),
  spEntityId: () => 'https://acme.xid.dev/saml/conn_1',
  acsUrl: () => 'https://acme.xid.dev/sso/saml/conn_1/acs',
  sloUrl: () => 'https://acme.xid.dev/sso/saml/conn_1/slo',
}))
vi.mock('../saml-jit', () => ({ provisionUser: (...a: unknown[]) => provisionUserMock(...a) }))
vi.mock('../saml-do', () => ({
  storeAuthnRequestId: vi.fn(),
  consumeAuthnRequestContext: (...a: unknown[]) => consumeAuthnRequestIdMock(...a),
  isAssertionReplay: (...a: unknown[]) => isAssertionReplayMock(...a),
  isLogoutRequestReplay: (...a: unknown[]) => isLogoutRequestReplayMock(...a),
  releaseLogoutRequestReplay: (...a: unknown[]) => releaseLogoutRequestReplayMock(...a),
  restoreConsumedSamlSessionBindings: (...a: unknown[]) =>
    restoreConsumedSamlSessionBindingsMock(...a),
  storeInboundSamlSessionIndex: (...a: unknown[]) => storeInboundSamlSessionIndexMock(...a),
  resolveInboundSamlSessionIndex: (...a: unknown[]) => resolveInboundSamlSessionIndexMock(...a),
  resolveInboundSamlSessionByNameId: (...a: unknown[]) =>
    resolveInboundSamlSessionByNameIdMock(...a),
}))
vi.mock('../saml-views', () => ({
  buildSpMetadata: (...a: unknown[]) => buildSpMetadataMock(...a),
  redirectToIdp: redirectToIdpMock,
}))
vi.mock('../../lib/session', () => ({
  issueSession: (...a: unknown[]) => issueSessionMock(...a),
  revokeSession: (...a: unknown[]) => revokeSessionMock(...a),
  sessionDoRevoke: (...a: unknown[]) => sessionDoRevokeMock(...a),
}))
vi.mock('@xid-kit/db', () => ({
  resolveTenantContextByApplicationClientId: (...a: unknown[]) =>
    resolveTenantContextByApplicationClientIdMock(...a),
  resolveTenantContextBySsoConnection: (...a: unknown[]) =>
    resolveTenantContextBySsoConnectionMock(...a),
  createTenantDb: () => ({
    sessions: {
      findOne: vi.fn().mockResolvedValue({
        id: 'sess_1',
        userId: 'user_xid_1',
        status: 'active',
        activeOrgId: 'org_1',
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        rememberMe: true,
        isImpersonation: false,
        impersonatorUserId: null,
        acr: null,
        amr: null,
        aal: null,
      }),
      update: (...args: unknown[]) => sessionUpdateMock(...args),
    },
  }),
  schema: {
    sessions: { id: 'id', userId: 'user_id', status: 'status' },
  },
}))

import { Hono } from 'hono'
import type { Context, ErrorHandler } from 'hono'
import type { HostedAuthPolicy, TenantContext } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { registerSamlRoutes } from '../saml'
import { AppError, isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'

const errorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
  }
  return c.json({ code: 'server_error' }, 500)
}

const ENTERPRISE_SSO_ENABLED: HostedAuthPolicy = {
  ...DEFAULT_HOSTED_AUTH_POLICY,
  enterpriseSso: {
    enabled: true,
    allowLogin: true,
    allowJitUserCreation: true,
    domainDiscovery: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
  },
}

function tenant(hostedAuth = ENTERPRISE_SSO_ENABLED): TenantContext {
  return {
    tenantId: 't_1',
    issuer: 'https://acme.xid.dev',
    rpId: 'acme.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { hostedAuth },
  }
}

function rootTenant(): TenantContext {
  return {
    tenantId: 'tenant-entry',
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
    resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
  }
}

function resolvedTenant(hostedAuth = ENTERPRISE_SSO_ENABLED): TenantContext {
  return {
    tenantId: 'tenant-resolved',
    issuer: 'https://xid.dev',
    rpId: 'tenant-resolved.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { hostedAuth },
    hostedAuthOrigin: 'https://xid.dev',
    resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
  }
}

function makeApp(hostedAuth = ENTERPRISE_SSO_ENABLED): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', tenant(hostedAuth))
    await next()
  })
  registerSamlRoutes(app)
  app.onError(errorHandler)
  return app
}

function makeRootApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', rootTenant())
    await next()
  })
  registerSamlRoutes(app)
  app.onError(errorHandler)
  return app
}

const ENV = {
  DB: {},
  KEK: 'x',
  WEBAUTHN_CHALLENGE: {},
  SESSION_REVOCATION: {},
  AUDIT_QUEUE: { send: vi.fn() },
} as unknown as Env

const CONNECTION = {
  id: 'conn_1',
  orgId: 'org_1',
  protocol: 'saml',
  status: 'active',
  idpEntityId: 'https://idp.example.com',
  idpSloUrl: 'https://idp.example.com/slo',
  idpCertificates: ['CERT'],
  wantAuthnResponseSigned: true,
  wantAssertionsSigned: true,
  samlClockSkewMs: 120_000,
  attributeMapping: {},
  jitEnabled: true,
}

const ASSERTION = {
  assertionId: '_assert_0001',
  issuer: 'https://idp.example.com',
  audience: 'https://acme.xid.dev/saml/conn_1',
  subject: {
    nameId: 'user@example.com',
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
  },
  attributes: { custom: {} },
  signingCertFingerprint: 'AA:BB',
  notBefore: 0,
  notOnOrAfter: Date.now() + 600000,
}

async function bodyCode(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code
}

// ACS 协议错误渲染 HTML 错误页(浏览器 form POST 触达),错误码在页内展示。
async function expectErrorPage(res: Response, code: string): Promise<void> {
  expect(res.headers.get('content-type')).toContain('text/html')
  expect(await res.text()).toContain(code)
}

// HTTP-POST binding 的 SAMLResponse 是标准 base64;ACS 入口先 base64-decode 再 verify(verify 已 mock,
// 内容无关,只要是合法 base64 即可通过解码)。
const SAMLRESPONSE_B64 = btoa('<samlp:Response/>')

function acsRequest(relayState?: string): Request {
  const body = new URLSearchParams({
    SAMLResponse: SAMLRESPONSE_B64,
    ...(relayState ? { RelayState: relayState } : {}),
  })
  return new Request('https://acme.xid.dev/sso/saml/conn_1/acs', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}

describe('ACS /sso/saml/:connection/acs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveTenantContextBySsoConnectionMock.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant() },
    })
    resolveConnectionMock.mockResolvedValue(CONNECTION)
    loadSpDecryptKeyMock.mockResolvedValue(undefined)
    verifyMock.mockResolvedValue({ ok: true, value: ASSERTION })
    isAssertionReplayMock.mockResolvedValue(false)
    provisionUserMock.mockResolvedValue('user_xid_1')
    issueSessionMock.mockResolvedValue(undefined)
    storeInboundSamlSessionIndexMock.mockResolvedValue(undefined)
  })

  it('验签成功 -> JIT -> session -> 302 回跳本租户 RelayState', async () => {
    const res = await makeApp().request(acsRequest('https://acme.xid.dev/app'), {}, ENV)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://acme.xid.dev/app')
    expect(verifyMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ spInitiated: 'auto' }),
    )
    expect(provisionUserMock).toHaveBeenCalledOnce()
    expect(issueSessionMock).toHaveBeenCalledOnce()
  })

  it.each(['SAMLResponse', 'RelayState'])(
    'rejects duplicate HTTP-POST %s fields before SAML verification',
    async (field) => {
      const body = new URLSearchParams({
        SAMLResponse: SAMLRESPONSE_B64,
        RelayState: 'https://acme.xid.dev/app',
      })
      body.append(field, field === 'SAMLResponse' ? SAMLRESPONSE_B64 : '/console')
      const res = await makeApp().request(
        'https://acme.xid.dev/sso/saml/conn_1/acs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        },
        ENV,
      )

      expect(res.status).toBe(400)
      await expectErrorPage(res, 'malformed_request')
      expect(verifyMock).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'raw token query',
      relayState: 'https://acme.xid.dev/accept-invitation?token=tenant-bound-invitation-token',
    },
    {
      name: 'fragment secret',
      relayState: 'https://acme.xid.dev/accept-invitation#claim_token=raw-secret',
    },
    {
      name: 'parameter alias',
      relayState: 'https://acme.xid.dev/accept-invitation?claim_token=raw-secret',
    },
  ])(
    'rejects an invitation RelayState with $name before SAML verification, ChallengeStore, or JIT',
    async ({ relayState }) => {
      const res = await makeApp().request(acsRequest(relayState), {}, ENV)

      expect(res.status).toBe(400)
      await expectErrorPage(res, 'invalid_request')
      expect(verifyMock).not.toHaveBeenCalled()
      expect(consumeAuthnRequestIdMock).not.toHaveBeenCalled()
      expect(provisionUserMock).not.toHaveBeenCalled()
      expect(issueSessionMock).not.toHaveBeenCalled()
    },
  )

  it('rejects a legacy stored raw invitation continuation before JIT or session writes', async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      value: { ...ASSERTION, inResponseTo: '_req_invitation' },
    })
    consumeAuthnRequestIdMock.mockResolvedValue({
      tenantId: 't_1',
      continuePath: '/accept-invitation?token=raw-secret',
      applicationClientId: null,
    })

    const res = await makeApp().request(acsRequest(), {}, ENV)

    expect(res.status).toBe(400)
    await expectErrorPage(res, 'invalid_request')
    expect(consumeAuthnRequestIdMock).toHaveBeenCalledOnce()
    expect(provisionUserMock).not.toHaveBeenCalled()
    expect(issueSessionMock).not.toHaveBeenCalled()
  })

  it('ACS stores SessionIndex mapping with session-length TTL', async () => {
    const res = await makeApp().request(acsRequest(), {}, ENV)
    expect(res.status).toBe(302)
    expect(storeInboundSamlSessionIndexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn_1',
        ttlMs: expect.any(Number),
        nameId: 'user@example.com',
      }),
    )
    const ttlMs = storeInboundSamlSessionIndexMock.mock.calls[0]?.[0]?.ttlMs as number
    expect(ttlMs).toBeGreaterThan(24 * 60 * 60 * 1000)
  })

  it('EncryptedAssertion 解密 key 存在时传入 verifySamlResponse', async () => {
    const spDecryptKey = {} as CryptoKey
    loadSpDecryptKeyMock.mockResolvedValue(spDecryptKey)

    const res = await makeApp().request(acsRequest('https://acme.xid.dev/app'), {}, ENV)

    expect(res.status).toBe(302)
    expect(loadSpDecryptKeyMock).toHaveBeenCalledWith(expect.anything(), CONNECTION)
    expect(verifyMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ spDecryptKey, clockSkewToleranceMs: 120_000 }),
    )
  })

  it('非本租户 RelayState -> 回退默认登录后页', async () => {
    const res = await makeApp().request(acsRequest('https://evil.com/x'), {}, ENV)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://acme.xid.dev/console')
  })

  it('前缀相似但不同 origin 的 RelayState -> 回退默认登录后页', async () => {
    const res = await makeApp().request(acsRequest('https://acme.xid.dev.evil.com/x'), {}, ENV)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://acme.xid.dev/console')
  })

  it('root ACS 按 connectionId 切到最终 tenant 后签 session', async () => {
    const res = await makeRootApp().request(acsRequest('https://xid.dev/account'), {}, ENV)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://xid.dev/account')
    expect(resolveTenantContextBySsoConnectionMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'conn_1',
    )
    expect(provisionUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        c: expect.objectContaining({}),
        connection: CONNECTION,
      }),
    )
    expect(issueSessionMock).toHaveBeenCalledOnce()
  })

  it('enterprise SSO 未启用时 ACS 拒绝且不验 SAMLResponse', async () => {
    const res = await makeApp(DEFAULT_HOSTED_AUTH_POLICY).request(acsRequest(), {}, ENV)

    expect(res.status).toBe(401)
    await expectErrorPage(res, 'invalid_credentials')
    expect(resolveConnectionMock).toHaveBeenCalledOnce()
    expect(verifyMock).not.toHaveBeenCalled()
    expect(provisionUserMock).not.toHaveBeenCalled()
    expect(issueSessionMock).not.toHaveBeenCalled()
  })

  it('SAMLResponse 缺失 -> 400 malformed_request', async () => {
    const req = new Request('https://acme.xid.dev/sso/saml/conn_1/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'RelayState=x',
    })
    const res = await makeApp().request(req, {}, ENV)
    expect(res.status).toBe(400)
    await expectErrorPage(res, 'malformed_request')
  })

  it('SAMLResponse 非法 base64 -> 400 malformed_request', async () => {
    const req = new Request('https://acme.xid.dev/sso/saml/conn_1/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLResponse: 'not_valid_base64!!!' }).toString(),
    })
    const res = await makeApp().request(req, {}, ENV)
    expect(res.status).toBe(400)
    await expectErrorPage(res, 'malformed_request')
    expect(verifyMock).not.toHaveBeenCalled()
  })

  it('SAMLResponse 超 256KB -> 400 malformed_request 且不进入验签', async () => {
    const req = new Request('https://acme.xid.dev/sso/saml/conn_1/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLResponse: 'QUJD'.repeat(70 * 1024) }).toString(),
    })
    const res = await makeApp().request(req, {}, ENV)
    expect(res.status).toBe(400)
    await expectErrorPage(res, 'malformed_request')
    expect(verifyMock).not.toHaveBeenCalled()
  })

  it('验签失败 -> 401 signature_invalid', async () => {
    verifyMock.mockResolvedValue({ ok: false, error: { code: 'signature_invalid', reason: 'bad' } })
    const res = await makeApp().request(acsRequest(), {}, ENV)
    expect(res.status).toBe(401)
    await expectErrorPage(res, 'signature_invalid')
  })

  it('Assertion 重放 -> 403 replay_detected', async () => {
    isAssertionReplayMock.mockResolvedValue(true)
    const res = await makeApp().request(acsRequest(), {}, ENV)
    expect(res.status).toBe(403)
    await expectErrorPage(res, 'replay_detected')
  })
})

describe('SAML SP initiated login policy gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveConnectionMock.mockResolvedValue(CONNECTION)
    redirectToIdpMock.mockResolvedValue(new Response(null, { status: 302 }))
  })

  it('enterprise SSO 未启用时 direct login 拒绝且不跳 IdP', async () => {
    const res = await makeApp(DEFAULT_HOSTED_AUTH_POLICY).request(
      'https://acme.xid.dev/sso/saml/conn_1/login',
      {},
      ENV,
    )

    expect(res.status).toBe(401)
    expect(await bodyCode(res)).toBe('invalid_credentials')
    expect(resolveConnectionMock).not.toHaveBeenCalled()
    expect(redirectToIdpMock).not.toHaveBeenCalled()
  })

  it('enterprise SSO 已启用时 direct login 会保留 Hosted Auth continue 回跳', async () => {
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/login?continue=%2Fconsole',
      {},
      ENV,
    )

    expect(res.status).toBe(302)
    expect(redirectToIdpMock).toHaveBeenCalled()
    const request = redirectToIdpMock.mock.calls[0]?.[0] as Context<XidHonoEnv>
    expect(request.req.query('continue')).toBe('/console')
  })

  it.each([
    {
      name: 'invitation_token parameter',
      query: 'invitation_token=raw-secret',
    },
    {
      name: 'raw token continue path',
      query: 'continue=%2Faccept-invitation%3Ftoken%3Draw-secret',
    },
    {
      name: 'raw token RelayState',
      query: 'relay_state=%2Faccept-invitation%3Ftoken%3Draw-secret',
    },
    {
      name: 'invitation RelayState fragment secret',
      query: 'relay_state=%2Faccept-invitation%23claim_token%3Draw-secret',
    },
    {
      name: 'invitation RelayState parameter alias',
      query: 'relay_state=%2Faccept-invitation%3Fclaim_token%3Draw-secret',
    },
  ])('rejects $name before AuthnRequest storage or IdP redirect', async ({ query }) => {
    const res = await makeApp().request(
      `https://acme.xid.dev/sso/saml/conn_1/login?${query}`,
      {},
      ENV,
    )

    expect(res.status).toBe(400)
    expect(await bodyCode(res)).toBe('invalid_request')
    expect(resolveConnectionMock).not.toHaveBeenCalled()
    expect(redirectToIdpMock).not.toHaveBeenCalled()
  })

  it('Application SSO login binds client and authorize continuation to the request record', async () => {
    resolveTenantContextByApplicationClientIdMock.mockResolvedValue({
      ok: true,
      value: tenant(),
    })
    const continuation = '/authorize?authz_request_id=authz_1&client_id=rp_client'
    const params = new URLSearchParams({
      continue: continuation,
      client_id: 'rp_client',
      intent: 'application-sign-up',
    })

    const res = await makeApp().request(
      `https://acme.xid.dev/sso/saml/conn_1/login?${params}`,
      {},
      ENV,
    )

    expect(res.status).toBe(302)
    expect(resolveTenantContextByApplicationClientIdMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'rp_client',
    )
    expect(redirectToIdpMock).toHaveBeenCalledWith(
      expect.anything(),
      CONNECTION,
      expect.any(Function),
      {
        tenantId: 't_1',
        continuePath: continuation,
        applicationClientId: 'rp_client',
      },
    )
  })

  it('Application SSO login rejects a continuation bound to another client', async () => {
    const params = new URLSearchParams({
      continue: '/authorize?authz_request_id=authz_1&client_id=other_client',
      client_id: 'rp_client',
      intent: 'application-sign-up',
    })

    const res = await makeApp().request(
      `https://acme.xid.dev/sso/saml/conn_1/login?${params}`,
      {},
      ENV,
    )

    expect(res.status).toBe(400)
    expect(redirectToIdpMock).not.toHaveBeenCalled()
  })
})

describe('SAML metadata policy gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveConnectionMock.mockResolvedValue(CONNECTION)
    buildSpMetadataMock.mockResolvedValue(
      new Response('<EntityDescriptor />', {
        status: 200,
        headers: { 'content-type': 'application/samlmetadata+xml' },
      }),
    )
  })

  it('enterprise SSO 启用时 metadata 返回 SP XML', async () => {
    const res = await makeApp().request('https://acme.xid.dev/sso/saml/conn_1/metadata', {}, ENV)

    expect(res.status).toBe(200)
    expect(buildSpMetadataMock).toHaveBeenCalledOnce()
    expect(resolveConnectionMock).toHaveBeenCalledOnce()
  })

  it('enterprise SSO 未启用时 metadata 拒绝且不生成 XML', async () => {
    const res = await makeApp(DEFAULT_HOSTED_AUTH_POLICY).request(
      'https://acme.xid.dev/sso/saml/conn_1/metadata',
      {},
      ENV,
    )

    expect(res.status).toBe(401)
    expect(await bodyCode(res)).toBe('invalid_credentials')
    expect(resolveConnectionMock).not.toHaveBeenCalled()
    expect(buildSpMetadataMock).not.toHaveBeenCalled()
  })
})

describe('SAML inbound SLO /sso/saml/:connection/slo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveTenantContextBySsoConnectionMock.mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: tenant() },
    })
    resolveConnectionMock.mockResolvedValue(CONNECTION)
    decodeSamlBindingPayloadMock.mockResolvedValue({ ok: true, value: '<LogoutRequest/>' })
    verifyLogoutMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_logout_req_1',
        issuer: 'https://idp.example.com',
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: ['_session_1'],
      },
    })
    resolveInboundSamlSessionIndexMock.mockResolvedValue({
      userId: 'user_xid_1',
      sessionId: 'sess_1',
    })
    isLogoutRequestReplayMock.mockResolvedValue(false)
    loadSpSigningKeyMock.mockResolvedValue({} as CryptoKey)
    buildLogoutResponseXmlMock.mockReturnValue({
      responseId: '_logout_resp_1',
      xml: '<LogoutResponse/>',
    })
    signLogoutResponseMock.mockResolvedValue({
      ok: true,
      value: {
        messageId: '_logout_resp_1',
        xml: '<LogoutResponse/>',
        samlMessage: btoa('<LogoutResponse/>'),
      },
    })
    signRedirectBindingResponseMock.mockResolvedValue({
      ok: true,
      value: {
        sigAlg: 'rsa-sha256',
        signature: 'response-signature',
        query:
          'SAMLResponse=encoded-logout-response&SigAlg=rsa-sha256&Signature=response-signature',
      },
    })
    revokeSessionMock.mockResolvedValue(undefined)
    sessionDoRevokeMock.mockResolvedValue(undefined)
    sessionUpdateMock.mockResolvedValue([{ id: 'sess_1', status: 'revoked' }])
    restoreConsumedSamlSessionBindingsMock.mockResolvedValue(undefined)
    releaseLogoutRequestReplayMock.mockResolvedValue(undefined)
  })

  it('POST LogoutRequest -> revoke mapped session -> auto-submit LogoutResponse', async () => {
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(200)
    expect(verifyLogoutMock).toHaveBeenCalledOnce()
    expect(resolveInboundSamlSessionIndexMock).toHaveBeenCalledWith(
      expect.anything(),
      'conn_1',
      '_session_1',
    )
    expect(isLogoutRequestReplayMock).toHaveBeenCalledWith(expect.anything(), {
      direction: 'inbound',
      scopeId: 'conn_1',
      requestId: '_logout_req_1',
      validUntil: expect.any(Number),
    })
    expect(revokeSessionMock).toHaveBeenCalledOnce()
    expect(signLogoutResponseMock).toHaveBeenCalledOnce()
  })

  it('consumes and revokes every SessionIndex in one LogoutRequest', async () => {
    verifyLogoutMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_logout_req_multi',
        issuer: 'https://idp.example.com',
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: ['_session_1', '_session_2'],
      },
    })
    resolveInboundSamlSessionIndexMock
      .mockResolvedValueOnce({ userId: 'user_xid_1', sessionId: 'sess_1' })
      .mockResolvedValueOnce({ userId: 'user_xid_1', sessionId: 'sess_1' })
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(200)
    expect(resolveInboundSamlSessionIndexMock.mock.calls).toEqual([
      [expect.anything(), 'conn_1', '_session_1'],
      [expect.anything(), 'conn_1', '_session_2'],
    ])
    expect(revokeSessionMock).toHaveBeenCalledTimes(2)
  })

  it('attempts every mapping and stays fail-closed when the primary revocation path fails', async () => {
    verifyLogoutMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_logout_req_partial_failure',
        issuer: 'https://idp.example.com',
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: ['_session_1', '_session_2'],
      },
    })
    resolveInboundSamlSessionIndexMock
      .mockResolvedValueOnce({ userId: 'user_xid_1', sessionId: 'sess_1' })
      .mockResolvedValueOnce({ userId: 'user_xid_1', sessionId: 'sess_1' })
    revokeSessionMock
      .mockRejectedValueOnce(new Error('session revocation unavailable'))
      .mockResolvedValueOnce(undefined)
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(200)
    expect(resolveInboundSamlSessionIndexMock).toHaveBeenCalledTimes(2)
    expect(revokeSessionMock).toHaveBeenCalledTimes(2)
    expect(sessionDoRevokeMock).toHaveBeenCalledOnce()
    expect(sessionUpdateMock).toHaveBeenCalledOnce()
    expect(releaseLogoutRequestReplayMock).not.toHaveBeenCalled()
  })

  it('restores exact mappings and releases the replay claim when both revoke stores fail', async () => {
    const consumedBinding = {
      bindingId: 'binding_retry',
      consumedAt: 1_000,
      userId: 'user_xid_1',
      sessionId: 'sess_1',
    }
    resolveInboundSamlSessionIndexMock.mockResolvedValue(consumedBinding)
    revokeSessionMock
      .mockRejectedValueOnce(new Error('primary revocation failed'))
      .mockResolvedValue(undefined)
    sessionDoRevokeMock
      .mockRejectedValueOnce(new Error('SessionDO unavailable'))
      .mockResolvedValue(undefined)
    sessionUpdateMock
      .mockRejectedValueOnce(new Error('D1 unavailable'))
      .mockResolvedValue([{ id: 'sess_1', status: 'revoked' }])
    const body = () => new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })

    const failed = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )
    const retried = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )

    expect(failed.status).toBe(500)
    expect(await bodyCode(failed)).toBe('server_error')
    expect(retried.status).toBe(200)
    expect(restoreConsumedSamlSessionBindingsMock).toHaveBeenCalledWith(expect.anything(), {
      direction: 'inbound',
      scopeId: 'conn_1',
      bindings: [consumedBinding],
    })
    expect(releaseLogoutRequestReplayMock).toHaveBeenCalledOnce()
    expect(restoreConsumedSamlSessionBindingsMock.mock.invocationCallOrder[0]).toBeLessThan(
      releaseLogoutRequestReplayMock.mock.invocationCallOrder[0]!,
    )
    expect(resolveInboundSamlSessionIndexMock).toHaveBeenCalledTimes(2)
  })

  it('replayed LogoutRequest cannot consume another session binding', async () => {
    isLogoutRequestReplayMock.mockResolvedValue(true)
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(403)
    expect(resolveInboundSamlSessionIndexMock).not.toHaveBeenCalled()
    expect(revokeSessionMock).not.toHaveBeenCalled()
    expect(releaseLogoutRequestReplayMock).not.toHaveBeenCalled()
  })

  it('GET redirect LogoutRequest -> 302 LogoutResponse redirect', async () => {
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo?SAMLRequest=abc%2fdef&RelayState=state+value&SigAlg=rsa%2dsha256&Signature=request-signature',
      { method: 'GET' },
      ENV,
    )

    expect(res.status).toBe(302)
    expect(decodeSamlBindingPayloadMock).toHaveBeenCalledWith('abc/def', 'redirect')
    expect(verifyLogoutMock).toHaveBeenCalledWith(
      '<LogoutRequest/>',
      expect.objectContaining({
        redirectSignature: expect.objectContaining({
          samlRequestEncoded: 'abc/def',
          relayState: 'state value',
          sigAlg: 'rsa-sha256',
          wireEncoded: {
            samlMessage: 'abc%2fdef',
            relayState: 'state+value',
            sigAlg: 'rsa%2dsha256',
          },
        }),
      }),
    )
    expect(signRedirectBindingResponseMock).toHaveBeenCalledWith(
      'encoded-logout-response',
      'state value',
      expect.anything(),
    )
    expect(res.headers.get('location')).toBe(
      'https://idp.example.com/slo?SAMLResponse=encoded-logout-response&SigAlg=rsa-sha256&Signature=response-signature',
    )
  })

  it('rejects duplicate Redirect binding parameters before decoding', async () => {
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo?SAMLRequest=a&SAMLRequest=b&SigAlg=rsa-sha256&Signature=sig',
      { method: 'GET' },
      ENV,
    )

    expect(res.status).toBe(400)
    expect(decodeSamlBindingPayloadMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate HTTP-POST SAMLRequest fields before decoding', async () => {
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    body.append('SAMLRequest', btoa('<OtherLogoutRequest/>'))
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(400)
    expect(decodeSamlBindingPayloadMock).not.toHaveBeenCalled()
  })

  it('LogoutRequest without SessionIndex consumes and revokes every NameID mapping', async () => {
    verifyLogoutMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_logout_req_2',
        issuer: 'https://idp.example.com',
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: [],
        nameId: 'user@example.com',
      },
    })
    resolveInboundSamlSessionByNameIdMock.mockResolvedValue([
      { userId: 'user_xid_1', sessionId: 'sess_1' },
      { userId: 'user_xid_1', sessionId: 'sess_1' },
    ])
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )
    expect(res.status).toBe(200)
    expect(resolveInboundSamlSessionByNameIdMock).toHaveBeenCalledWith(
      expect.anything(),
      'conn_1',
      'user@example.com',
    )
    expect(revokeSessionMock).toHaveBeenCalledTimes(2)
  })

  it('releases the replay claim when NameID mapping consumption fails so the request can retry', async () => {
    verifyLogoutMock.mockResolvedValue({
      ok: true,
      value: {
        requestId: '_logout_req_name_id_retry',
        issuer: 'https://idp.example.com',
        validUntil: Date.now() + 5 * 60 * 1000,
        sessionIndexes: [],
        nameId: 'user@example.com',
      },
    })
    resolveInboundSamlSessionByNameIdMock
      .mockRejectedValueOnce(new Error('D1 UPDATE RETURNING unavailable'))
      .mockResolvedValueOnce([
        {
          bindingId: 'binding_name_id_retry',
          consumedAt: 1_000,
          userId: 'user_xid_1',
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
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )
    const retried = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      },
      ENV,
    )

    expect(failed.status).toBe(500)
    expect(await bodyCode(failed)).toBe('server_error')
    expect(retried.status).toBe(200)
    expect(resolveInboundSamlSessionByNameIdMock).toHaveBeenCalledTimes(2)
    expect(restoreConsumedSamlSessionBindingsMock).toHaveBeenCalledWith(expect.anything(), {
      direction: 'inbound',
      scopeId: 'conn_1',
      bindings: [],
    })
    expect(releaseLogoutRequestReplayMock).toHaveBeenCalledOnce()
    expect(revokeSessionMock).toHaveBeenCalledOnce()
  })

  it('fails closed when the connection has no configured IdP SingleLogoutService', async () => {
    resolveConnectionMock.mockResolvedValue({ ...CONNECTION, idpSloUrl: null })
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )

    expect(res.status).toBe(404)
    expect(await bodyCode(res)).toBe('connection_not_found')
    expect(loadSpSigningKeyMock).not.toHaveBeenCalled()
    expect(isLogoutRequestReplayMock).not.toHaveBeenCalled()
    expect(revokeSessionMock).not.toHaveBeenCalled()
  })

  it('验签失败 -> 401 signature_invalid', async () => {
    verifyLogoutMock.mockResolvedValue({
      ok: false,
      error: { code: 'signature_invalid', reason: 'bad sig' },
    })
    const body = new URLSearchParams({ SAMLRequest: btoa('<LogoutRequest/>') })
    const res = await makeApp().request(
      'https://acme.xid.dev/sso/saml/conn_1/slo',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
      ENV,
    )
    expect(res.status).toBe(401)
    expect(await bodyCode(res)).toBe('signature_invalid')
  })
})

describe('ACS error branches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveConnectionMock.mockResolvedValue(CONNECTION)
    loadSpDecryptKeyMock.mockResolvedValue(undefined)
    verifyMock.mockResolvedValue({ ok: true, value: ASSERTION })
    isAssertionReplayMock.mockResolvedValue(false)
    provisionUserMock.mockResolvedValue('user_xid_1')
    issueSessionMock.mockResolvedValue(undefined)
    storeInboundSamlSessionIndexMock.mockResolvedValue(undefined)
  })

  it('JIT 关闭且用户不存在 -> 403 provisioning_disabled', async () => {
    provisionUserMock.mockRejectedValue(new AppError('provisioning_disabled', { httpStatus: 403 }))
    const res = await makeApp().request(acsRequest(), {}, ENV)
    expect(res.status).toBe(403)
    await expectErrorPage(res, 'provisioning_disabled')
  })

  it('connection 不存在 -> 404 connection_not_found', async () => {
    resolveConnectionMock.mockRejectedValue(
      new AppError('connection_not_found', { httpStatus: 404 }),
    )
    const res = await makeApp().request(acsRequest(), {}, ENV)
    expect(res.status).toBe(404)
    await expectErrorPage(res, 'connection_not_found')
  })

  it('SP-initiated InResponseTo 未知 -> 403 recipient_mismatch', async () => {
    verifyMock.mockResolvedValue({ ok: true, value: { ...ASSERTION, inResponseTo: '_req_x' } })
    consumeAuthnRequestIdMock.mockResolvedValue(null)
    const res = await makeApp().request(acsRequest(), {}, ENV)
    expect(res.status).toBe(403)
    await expectErrorPage(res, 'recipient_mismatch')
  })

  it('SP-initiated InResponseTo 已存 -> 302 并建立 session', async () => {
    verifyMock.mockResolvedValue({ ok: true, value: { ...ASSERTION, inResponseTo: '_req_x' } })
    consumeAuthnRequestIdMock.mockResolvedValue({
      tenantId: 't_1',
      continuePath: '/app',
      applicationClientId: null,
    })
    const res = await makeApp().request(acsRequest('https://acme.xid.dev/attacker'), {}, ENV)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://acme.xid.dev/app')
    expect(consumeAuthnRequestIdMock).toHaveBeenCalledWith(expect.anything(), 'conn_1', '_req_x')
    expect(issueSessionMock).toHaveBeenCalledOnce()
  })
})
