// 出站 SAML /sso 对 ForceAuthn、IsPassive 与 NameIDPolicy 的处理。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import { isAppError } from '../../lib/errors'
import type { SessionData, XidHonoEnv } from '../../lib/types'

const {
  signSamlResponseMock,
  signSamlStatusResponseMock,
  verifySamlAuthnRequestMock,
  trackOutboundSamlSessionMock,
  readStepUpAuthContextMock,
  clearStepUpCookieMock,
  hasStrongMfaFactorMock,
  signingKey,
} = vi.hoisted(() => ({
  signSamlResponseMock: vi.fn(),
  signSamlStatusResponseMock: vi.fn(),
  verifySamlAuthnRequestMock: vi.fn(),
  trackOutboundSamlSessionMock: vi.fn(),
  readStepUpAuthContextMock: vi.fn(),
  clearStepUpCookieMock: vi.fn(),
  hasStrongMfaFactorMock: vi.fn(),
  signingKey: { kind: 'idp-signing-key' },
}))

vi.mock('../../lib/step-up', () => ({
  readStepUpAuthContext: (...args: unknown[]) => readStepUpAuthContextMock(...args),
  clearStepUpCookie: (...args: unknown[]) => clearStepUpCookieMock(...args),
}))

vi.mock('../../lib/mfa-methods', () => ({
  hasStrongMfaFactor: (...args: unknown[]) => hasStrongMfaFactorMock(...args),
}))

vi.mock('@xid-kit/saml', async (importOriginal) => ({
  SAML_STATUS: (await importOriginal<typeof import('@xid-kit/saml')>()).SAML_STATUS,
  signSamlStatusResponse: (...args: unknown[]) => signSamlStatusResponseMock(...args),
  buildIdpMetadataXml: vi.fn(() => '<EntityDescriptor />'),
  decodeSamlBindingPayload: vi.fn().mockResolvedValue({ ok: true, value: '<AuthnRequest/>' }),
  loadIdpVerifyKey: vi.fn().mockResolvedValue({
    ok: true,
    value: { notBefore: 0, notAfter: Date.now() + 24 * 60 * 60 * 1000 },
  }),
  signSamlResponse: (...args: unknown[]) => signSamlResponseMock(...args),
  verifySamlAuthnRequest: (...args: unknown[]) => verifySamlAuthnRequestMock(...args),
}))

vi.mock('../outbound-saml-signing', () => ({
  loadSigningCert: vi.fn().mockResolvedValue({ id: 'cert_1', certificate: 'CERT' }),
  importSamlSigningKey: vi.fn().mockResolvedValue(signingKey),
}))

vi.mock('../outbound-saml-persistent-name-id', () => ({
  resolvePersistentNameId: vi.fn().mockResolvedValue('stored-persistent-name-id'),
}))

vi.mock('../saml-do', () => ({
  trackOutboundSamlSession: (...args: unknown[]) => trackOutboundSamlSessionMock(...args),
}))

vi.mock('../tenant', () => ({
  resolveSamlServiceProviderTenant: vi.fn().mockResolvedValue({ tenantId: 'tenant_1' }),
  withTenant: async (_c: unknown, _tenant: unknown, fn: () => Promise<unknown>) => fn(),
}))

const SP = {
  id: 'sp_1',
  tenantId: 'tenant_1',
  orgId: 'org_1',
  spEntityId: 'https://saas.example.com/saml',
  acsUrl: 'https://saas.example.com/acs',
  sloUrl: null,
  sloBinding: 'redirect',
  spCertificates: [],
  attributeMapping: {},
  nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
  idpSigningCertId: 'cert_1',
}

const spFindOne = vi.fn()
const userEmailFindOne = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    samlServiceProviders: { findOne: spFindOne },
    users: {
      findOne: vi.fn().mockResolvedValue({ id: 'user_1', status: 'active', primaryEmailId: 'e_1' }),
    },
    userEmails: { findOne: userEmailFindOne },
    memberships: { findOne: vi.fn().mockResolvedValue({ role: 'member', status: 'active' }) },
    managerAssignments: { findOne: vi.fn().mockResolvedValue(undefined) },
  })),
  schema: {
    samlServiceProviders: { id: 'id' },
    certStore: { id: 'id', usage: 'usage', status: 'status' },
    users: { id: 'id', status: 'status' },
    userEmails: { id: 'id', userId: 'userId' },
    memberships: { userId: 'userId', orgId: 'orgId', status: 'status' },
    managerAssignments: {
      userId: 'userId',
      managerRole: 'managerRole',
      scopeType: 'scopeType',
      scopeId: 'scopeId',
    },
  },
}))

import { registerOutboundSamlRoutes } from '../outbound-saml'

const SSO_URL = 'https://acme.xid.dev/sso/outbound/saml/sp_1/sso'
const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'

const errorHandler: ErrorHandler<XidHonoEnv> = (err, c) =>
  isAppError(err)
    ? c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
    : c.json({ code: 'server_error' }, 500)

function continuationStore(): DurableObjectNamespace {
  const records = new Map<string, unknown>()
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { state: string }
        if (new URL(url).pathname === '/store') {
          records.set(body.state, body)
          return new Response(null, { status: 201 })
        }
        const record = records.get(body.state)
        records.delete(body.state)
        return record ? Response.json({ record }) : new Response('{}', { status: 404 })
      },
    }),
  } as unknown as DurableObjectNamespace
}

function makeEnv(): Env {
  return {
    DB: {},
    ENVIRONMENT: 'test',
    KEK: btoa('k'.repeat(32)),
    PEPPER: 'v1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    OAUTH_STATE: continuationStore(),
  } as unknown as Env
}

function session(authenticatedAt: Date): SessionData {
  return {
    sessionId: 'sess_1',
    userId: 'user_1',
    status: 'active',
    activeOrgId: null,
    authenticatedAt,
    lastActiveAt: authenticatedAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
  }
}

function makeApp(current?: SessionData) {
  const app = new Hono<XidHonoEnv>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId: 'tenant_1',
      issuer: 'https://acme.xid.dev',
      rpId: 'acme.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
    } as never)
    if (current) c.set('session', current)
    await next()
  })
  registerOutboundSamlRoutes(app)
  return app
}

function authnRequest(overrides: Record<string, unknown> = {}) {
  verifySamlAuthnRequestMock.mockResolvedValue({
    ok: true,
    value: {
      requestId: '_authn_1',
      issuer: SP.spEntityId,
      destination: SSO_URL,
      acsUrl: SP.acsUrl,
      signatureVerified: false,
      forceAuthn: false,
      isPassive: false,
      nameIdPolicy: null,
      requestedAuthnContext: null,
      ...overrides,
    },
  })
}

async function decodedSamlResponse(res: Response): Promise<string> {
  const html = await res.text()
  const encoded = /name="SAMLResponse" value="([^"]+)"/.exec(html)?.[1] ?? ''
  return atob(encoded)
}

function sso(app: Hono<XidHonoEnv>, env: Env, path = `${SSO_URL}?SAMLRequest=req`) {
  return app.request(path, {}, env)
}

beforeEach(() => {
  vi.clearAllMocks()
  spFindOne.mockResolvedValue(SP)
  userEmailFindOne.mockResolvedValue({ email: 'user@example.com' })
  signSamlResponseMock.mockResolvedValue({ ok: true, value: { samlResponse: btoa('<R/>') } })
  signSamlStatusResponseMock.mockImplementation(async (input: unknown) => {
    const { buildSamlStatusResponseXml } =
      await vi.importActual<typeof import('@xid-kit/saml')>('@xid-kit/saml')
    const built = buildSamlStatusResponseXml(
      input as Parameters<typeof buildSamlStatusResponseXml>[0],
    )
    return { ok: true, value: { ...built, samlResponse: btoa(built.xml) } }
  })
  readStepUpAuthContextMock.mockResolvedValue(null)
  hasStrongMfaFactorMock.mockResolvedValue(true)
  authnRequest()
})

describe('outbound SAML status Response signing', () => {
  it('signs the status Response with the SP signing key and the request routing fields', async () => {
    authnRequest({ isPassive: true })

    await sso(makeApp(), makeEnv())

    expect(signSamlStatusResponseMock).toHaveBeenCalledWith(
      {
        issuer: expect.stringContaining('sp_1'),
        destination: SP.acsUrl,
        inResponseTo: '_authn_1',
        topLevelStatus: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
        secondLevelStatus: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive',
      },
      signingKey,
    )
  })

  it('returns server_error instead of an unsigned Response when status signing fails', async () => {
    authnRequest({ isPassive: true })
    signSamlStatusResponseMock.mockResolvedValue({
      ok: false,
      error: { code: 'signature_invalid', reason: 'sign failed' },
    })

    const res = await sso(makeApp(), makeEnv())

    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('SAMLResponse')
  })
})

describe('outbound SAML IsPassive', () => {
  it('answers NoPassive to the ACS without redirecting when there is no session', async () => {
    authnRequest({ isPassive: true })

    const res = await sso(makeApp(), makeEnv())

    expect(res.status).toBe(200)
    const xml = await decodedSamlResponse(res)
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:status:Responder')
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:status:NoPassive')
    expect(xml).toContain('InResponseTo="_authn_1"')
    expect(xml).not.toContain('Assertion')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('answers NoPassive when ForceAuthn and IsPassive are both set', async () => {
    authnRequest({ isPassive: true, forceAuthn: true })

    const res = await sso(makeApp(session(new Date(Date.now() - 60_000))), makeEnv())

    expect(await decodedSamlResponse(res)).toContain('status:NoPassive')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('issues an assertion silently when IsPassive is set and a session exists', async () => {
    authnRequest({ isPassive: true })

    const res = await sso(makeApp(session(new Date(Date.now() - 60_000))), makeEnv())

    expect(res.status).toBe(200)
    expect(signSamlResponseMock).toHaveBeenCalledTimes(1)
  })
})

describe('outbound SAML ForceAuthn', () => {
  it('sends an existing session back to sign-in with reauthenticate', async () => {
    authnRequest({ forceAuthn: true })

    const res = await sso(makeApp(session(new Date(Date.now() - 60_000))), makeEnv())

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('reauthenticate')).toBe('1')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('issues the assertion after a sign-in that happened after the request', async () => {
    authnRequest({ forceAuthn: true })
    const env = makeEnv()
    const first = await sso(makeApp(session(new Date(Date.now() - 60_000))), env)
    const resume = new URL(first.headers.get('location') ?? '').searchParams.get('continue') ?? ''

    const res = await sso(
      makeApp(session(new Date(Date.now() + 1_000))),
      env,
      `https://acme.xid.dev${resume}`,
    )

    expect(res.status).toBe(200)
    expect(signSamlResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ inResponseTo: '_authn_1' }),
      expect.anything(),
    )
  })

  it('does not accept the old session when resuming a ForceAuthn request', async () => {
    authnRequest({ forceAuthn: true })
    const env = makeEnv()
    const old = session(new Date(Date.now() - 60_000))
    const first = await sso(makeApp(old), env)
    const resume = new URL(first.headers.get('location') ?? '').searchParams.get('continue') ?? ''

    const res = await sso(makeApp(old), env, `https://acme.xid.dev${resume}`)

    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('reauthenticate')).toBe('1')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })
})

describe('outbound SAML attribute mapping', () => {
  function sentAttributes(): Record<string, unknown> {
    const input = signSamlResponseMock.mock.calls[0]?.[0] as { attributes: Record<string, unknown> }
    return input.attributes
  }

  it('sends the XID user id under the attribute named by the userId mapping key', async () => {
    spFindOne.mockResolvedValue({
      ...SP,
      attributeMapping: {
        userId: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      },
    })

    await sso(makeApp(session(new Date())), makeEnv())

    expect(sentAttributes()).toMatchObject({
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'user_1',
    })
  })

  it('does not send the user id when the mapping has no userId key', async () => {
    await sso(makeApp(session(new Date())), makeEnv())

    expect(Object.values(sentAttributes())).not.toContain('user_1')
  })
})

describe('outbound SAML NameIDPolicy', () => {
  it('returns InvalidNameIDPolicy for an unsupported requested format', async () => {
    authnRequest({
      nameIdPolicy: { format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName' },
    })

    const res = await sso(makeApp(session(new Date())), makeEnv())

    const xml = await decodedSamlResponse(res)
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:status:Requester')
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('issues the stored persistent NameID when the SP requests persistent', async () => {
    authnRequest({ nameIdPolicy: { format: PERSISTENT, allowCreate: true } })

    await sso(makeApp(session(new Date())), makeEnv())

    const input = signSamlResponseMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input['nameIdFormat']).toBe(PERSISTENT)
    expect(input['subjectNameId']).toBe('stored-persistent-name-id')
    expect(trackOutboundSamlSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ nameId: input['subjectNameId'], nameIdFormat: PERSISTENT }),
      expect.any(Number),
    )
  })

  it('returns InvalidNameIDPolicy when emailAddress is configured and the user has no email', async () => {
    userEmailFindOne.mockResolvedValue(undefined)

    const res = await sso(makeApp(session(new Date())), makeEnv())

    const xml = await decodedSamlResponse(res)
    expect(xml).toContain('status:Responder')
    expect(xml).toContain('status:InvalidNameIDPolicy')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })
})

describe('outbound SAML RequestedAuthnContext', () => {
  const PPT = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
  const MFA = 'https://refeds.org/profile/mfa'

  function passwordSession(authenticatedAt = new Date(Date.now() - 60_000)): SessionData {
    return { ...session(authenticatedAt), acr: 'urn:xid:aal1', amr: ['pwd'], aal: 1 }
  }

  function requestContext(comparison: string, classRefs: string[], declRefs: string[] = []) {
    authnRequest({ requestedAuthnContext: { comparison, classRefs, declRefs } })
  }

  function signedInput(): Record<string, unknown> {
    return signSamlResponseMock.mock.calls[0]?.[0] as Record<string, unknown>
  }

  function resumePath(res: Response, param: 'continue' | 'redirect_to'): string {
    return new URL(res.headers.get('location') ?? '').searchParams.get(param) ?? ''
  }

  it('writes the class the session actually achieved and its authentication instant', async () => {
    requestContext('exact', [PPT])
    const current = passwordSession()

    await sso(makeApp(current), makeEnv())

    expect(signedInput()['authnContextClassRef']).toBe(PPT)
    expect(signedInput()['authnInstant']).toBe(current.authenticatedAt.getTime())
  })

  it('writes the strongest achieved class when the SP requested none', async () => {
    await sso(makeApp(passwordSession()), makeEnv())

    expect(signedInput()['authnContextClassRef']).toBe(PPT)
  })

  it('sends a password session to MFA step-up when the SP requires MFA', async () => {
    requestContext('minimum', [MFA])

    const res = await sso(makeApp(passwordSession()), makeEnv())

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.pathname).toBe('/mfa')
    expect(location.searchParams.get('step_up')).toBe('1')
    expect(location.searchParams.get('redirect_to')).toMatch(/^\/sso\/outbound\/saml\/sp_1\/sso\?/)
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('answers NoPassive when MFA is required and IsPassive is set', async () => {
    authnRequest({
      isPassive: true,
      requestedAuthnContext: { comparison: 'exact', classRefs: [MFA], declRefs: [] },
    })

    const res = await sso(makeApp(passwordSession()), makeEnv())

    expect(await decodedSamlResponse(res)).toContain('status:NoPassive')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('issues the MFA class after the step-up and clears the step-up cookie', async () => {
    requestContext('exact', [MFA])
    const env = makeEnv()
    const current = passwordSession()
    const first = await sso(makeApp(current), env)
    readStepUpAuthContextMock.mockResolvedValue({
      authTime: Math.floor(Date.now() / 1000),
      acr: 'urn:xid:aal2',
      amr: ['pwd', 'otp', 'mfa'],
    })

    const res = await sso(
      makeApp(current),
      env,
      `https://acme.xid.dev${resumePath(first, 'redirect_to')}`,
    )

    expect(res.status).toBe(200)
    expect(signedInput()['authnContextClassRef']).toBe(MFA)
    expect(clearStepUpCookieMock).toHaveBeenCalledTimes(1)
  })

  it('answers NoAuthnContext instead of redirecting again when the step-up did not happen', async () => {
    requestContext('exact', [MFA])
    const env = makeEnv()
    const current = passwordSession()
    const first = await sso(makeApp(current), env)

    const res = await sso(
      makeApp(current),
      env,
      `https://acme.xid.dev${resumePath(first, 'redirect_to')}`,
    )

    const xml = await decodedSamlResponse(res)
    expect(xml).toContain('status:Requester')
    expect(xml).toContain('status:NoAuthnContext')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it('keeps the requested context across sign-in and then asks for step-up', async () => {
    requestContext('exact', [MFA])
    const env = makeEnv()
    const first = await sso(makeApp(), env)

    const res = await sso(
      makeApp(passwordSession(new Date())),
      env,
      `https://acme.xid.dev${resumePath(first, 'continue')}`,
    )

    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/mfa')
    expect(signSamlResponseMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'the user has no strong MFA factor',
      hasStrongFactor: false,
      comparison: 'exact',
      classRefs: [MFA],
      declRefs: [],
    },
    {
      label: 'the class is unknown to XID',
      hasStrongFactor: true,
      comparison: 'exact',
      classRefs: ['urn:example:ac:classes:Retina'],
      declRefs: [],
    },
    {
      label: 'nothing is stronger than MFA',
      hasStrongFactor: true,
      comparison: 'better',
      classRefs: [MFA],
      declRefs: [],
    },
    {
      label: 'the SP asks for a declaration',
      hasStrongFactor: true,
      comparison: 'exact',
      classRefs: [],
      declRefs: ['urn:example:decl:1'],
    },
  ])(
    'answers Requester NoAuthnContext when $label',
    async ({ hasStrongFactor, comparison, classRefs, declRefs }) => {
      hasStrongMfaFactorMock.mockResolvedValue(hasStrongFactor)
      requestContext(comparison, classRefs, declRefs)

      const res = await sso(makeApp(passwordSession()), makeEnv())

      expect(res.status).toBe(200)
      const xml = await decodedSamlResponse(res)
      expect(xml).toContain('status:Requester')
      expect(xml).toContain('status:NoAuthnContext')
      expect(xml).toContain('InResponseTo="_authn_1"')
      expect(signSamlResponseMock).not.toHaveBeenCalled()
    },
  )
})
