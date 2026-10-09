// saml-views.ts:SP metadata 的 AuthnRequestsSigned 与实际发出的 AuthnRequest 是否签名一致。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import { verifyRedirectBindingSignature } from '@xid-kit/saml'
import type { XidHonoEnv } from '../../lib/types'
import type { SamlConnection } from '../saml-connection'

const certStoreFindMany = vi.fn()
const loadSpSigningKeyMock = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({ certStore: { findMany: certStoreFindMany } })),
  schema: { certStore: { id: 'id', usage: 'usage', status: 'status' } },
}))

vi.mock('../saml-connection', () => ({
  acsUrl: () => 'https://acme.xid.dev/sso/saml/conn_1/acs',
  sloUrl: () => 'https://acme.xid.dev/sso/saml/conn_1/slo',
  spEntityId: () => 'https://acme.xid.dev/sso/saml/conn_1/metadata',
  loadSpSigningKey: (...args: unknown[]) => loadSpSigningKeyMock(...args),
}))

import { buildSpMetadata, redirectToIdp } from '../saml-views'

const TENANT = {
  tenantId: 'tenant_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'kid_1', defaultAlg: 'ES256' as const, keys: [] },
  policy: {},
}

const CONNECTION = {
  id: 'conn_1',
  idpSsoUrl: 'https://idp.example.com/sso',
  wantAssertionsSigned: true,
  spCertId: 'cert_decrypt_1',
} as unknown as SamlConnection

function makeContext(): Context<XidHonoEnv> {
  return {
    env: { DB: {} as D1Database, KEK: 'kek' } as Env,
    get: (key: string) => (key === 'tenant' ? TENANT : undefined),
    body: (xml: string, status: number, headers: Record<string, string>) =>
      new Response(xml, { status, headers }),
    redirect: (location: string) => new Response(null, { status: 302, headers: { location } }),
  } as unknown as Context<XidHonoEnv>
}

const FLOW = { tenantId: 'tenant_1', continuePath: '/account', applicationClientId: null }

async function generateSigningPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['sign', 'verify'],
  )
}

describe('buildSpMetadata AuthnRequestsSigned', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('declares false when there is no SP signing certificate, even with a decryption certificate', async () => {
    certStoreFindMany.mockResolvedValue([])

    const xml = await (await buildSpMetadata(makeContext(), CONNECTION)).text()

    expect(xml).toContain('AuthnRequestsSigned="false"')
  })

  it('declares true when an active SP signing certificate exists', async () => {
    certStoreFindMany
      .mockResolvedValueOnce([{ id: 'cert_sign_1', certificate: 'MIIBsigning' }])
      .mockResolvedValue([])

    const xml = await (await buildSpMetadata(makeContext(), CONNECTION)).text()

    expect(xml).toContain('AuthnRequestsSigned="true"')
  })
})

describe('redirectToIdp AuthnRequest signing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('signs SAMLRequest, RelayState and SigAlg with the SP signing key', async () => {
    const pair = await generateSigningPair()
    loadSpSigningKeyMock.mockResolvedValue(pair.privateKey)

    const response = await redirectToIdp(makeContext(), CONNECTION, vi.fn(), FLOW)

    const location = new URL(response.headers.get('location') ?? '')
    const raw = location.search.slice(1)
    const signedContent = raw.slice(0, raw.indexOf('&Signature='))
    const signature = location.searchParams.get('Signature') ?? ''
    const verified = await verifyRedirectBindingSignature(
      signedContent,
      signature,
      location.searchParams.get('SigAlg') ?? '',
      [{ publicKey: pair.publicKey, fingerprint: 'test', notBefore: 0, notAfter: Infinity }],
    )
    expect(location.searchParams.get('RelayState')).toBe('/account')
    expect(verified.ok).toBe(true)
  })

  it('sends an unsigned request when no SP signing key exists', async () => {
    loadSpSigningKeyMock.mockResolvedValue(null)

    const response = await redirectToIdp(makeContext(), CONNECTION, vi.fn(), FLOW)

    const location = new URL(response.headers.get('location') ?? '')
    expect(location.searchParams.get('SAMLRequest')).toBeTruthy()
    expect(location.searchParams.get('Signature')).toBeNull()
    expect(location.searchParams.get('SigAlg')).toBeNull()
  })
})
