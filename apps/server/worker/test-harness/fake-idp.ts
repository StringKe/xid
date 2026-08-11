// 本地 inbound SAML L3 用假上游 IdP;本地注入 RSA 签名,仅 development/test 注册。

import { toBufferSource } from '@xid-kit/crypto'
import { decodeSamlBindingPayload, signSamlResponse } from '@xid-kit/saml'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'

const FAKE_IDP_ENTITY_ID = 'https://fake-idp.example.com/metadata'
const FAKE_IDP_CERT_B64 =
  'MIICsDCCAZgCCQD671vtlnC3lzANBgkqhkiG9w0BAQsFADAaMRgwFgYDVQQDDA9pZHAuZXhhbXBsZS5jb20wHhcNMjYwNjAxMTk1NjAxWhcNMjcwNjAxMTk1NjAxWjAaMRgwFgYDVQQDDA9pZHAuZXhhbXBsZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCqRhFtrsRrqYIROKrtCdtSuCRmaMerEHqkA0Hf7d9kIBziBLGb2JIlFvdAS2FpV5sXkqM1awZBzHWO3KZ13mXFKqaGV2MwEByYC5SHbIBlaMC6s25D0xVOXvFe93x37DI7PWCwRzeJeU0Y2iPujIyTOZtgzdvzyLss2CLqwGcbBUIZQ5+uN5mJn8D06vOsde/cFD0lbDsOdxKH1KYGJPI0wGyd/TMgcIkhOAXeyRTdyFVHzzHrybRzgVFiJYj3ety2ZJmABdrNJ9xiuinL26ZvXeZ7JzNjhmYzgxFBnVR7f4fA6znu+E49Rs7HCKpapP4E5/ul5agusN1JV3Y9e4gnAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAGKQaB6EbRU3S4/z29UsNtA1O+++90px/pIYrA4Ni/Nai8hLuj6BCZFQVWzwQEacVwFEyTHLXZ/eor5H82gnmTWle6NmN7uX4C5siIHzQTCm9TOWuR0jLMm25eVyg/zLSfvF3l5qMJW7cxVGKCy/bB7jQ6liXC4zvRzNNo7mdNd9ot8L3j6Z1AzJE1eYqEGstfVnXZ5PB/EOrKb2mZvwAZ8bQWTE4IhItgNhQGDEN9bv7MfXySLKGiG/x8Y1w48GEVyV2dIBG13ThRSJze7B7NZQpKixZ7rJJGOTwDecBWc45HIais7bDlvjpJ6myBwJpX7MQY04RBLa+/vGanWumgw='

let signingKeyPromise: Promise<CryptoKey> | null = null

async function fakeIdpSigningKey(): Promise<CryptoKey> {
  if (!signingKeyPromise) {
    const raw = Uint8Array.from(atob(readFakeIdpPrivateKey()), (character) =>
      character.charCodeAt(0),
    )
    signingKeyPromise = crypto.subtle.importKey(
      'pkcs8',
      toBufferSource(raw),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  }
  return signingKeyPromise
}

function readFakeIdpPrivateKey(): string {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
  const key = runtime.process?.env?.XID_L3_SAML_IDP_KEY_PKCS8_B64
  if (!key) throw new AppError('server_error', { longMessage: 'fake IdP signing key missing' })
  return key
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

function parseAuthnRequest(xml: string): {
  issuer: string
  destination: string
  id: string
  acsUrl: string
} {
  const issuer = /<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/.exec(xml)?.[1] ?? ''
  const destination = /Destination="([^"]+)"/.exec(xml)?.[1] ?? ''
  const id = /ID="([^"]+)"/.exec(xml)?.[1] ?? ''
  const acsUrl = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] ?? destination
  return { issuer, destination, id, acsUrl }
}

async function issueFakeResponse(
  _c: Context<XidHonoEnv>,
  input: {
    acsUrl: string
    audience: string
    inResponseTo?: string
    relayState?: string
    email?: string
  },
): Promise<Response> {
  const email = input.email ?? 'fake-idp-user@example.com'
  const signed = await signSamlResponse(
    {
      issuer: FAKE_IDP_ENTITY_ID,
      audience: input.audience,
      acsUrl: input.acsUrl,
      subjectNameId: email,
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      inResponseTo: input.inResponseTo,
      attributes: {
        email: [email],
        firstName: ['Fake'],
        lastName: ['IdP'],
      },
      sessionIndex: `fake-idp-${crypto.randomUUID()}`,
    },
    await fakeIdpSigningKey(),
  )
  if (!signed.ok) throw new AppError('server_error', { longMessage: signed.error.reason })
  const relayState = input.relayState ?? ''
  const html = `<!DOCTYPE html><html><body onload="document.forms[0].submit()"><form method="post" action="${input.acsUrl}"><input type="hidden" name="SAMLResponse" value="${signed.value.samlResponse}"/><input type="hidden" name="RelayState" value="${relayState}"/></form></body></html>`
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

const fakeIdp = new Hono<XidHonoEnv>()

fakeIdp.get('/metadata', (c) => {
  requireHarness(c)
  const xml = `<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${FAKE_IDP_ENTITY_ID}"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${FAKE_IDP_CERT_B64}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${c.get('tenant').issuer}/test/fake-idp/saml/sso"/></IDPSSODescriptor></EntityDescriptor>`
  return c.body(xml, 200, { 'content-type': 'application/samlmetadata+xml' })
})

fakeIdp.get('/sso', async (c) => {
  requireHarness(c)
  const relayState = c.req.query('RelayState') ?? undefined
  const binding = await decodeSamlBindingPayload(c.req.query('SAMLRequest') ?? '', 'redirect')
  if (!binding.ok) throw new AppError('invalid_request', { longMessage: binding.error.reason })
  const authn = parseAuthnRequest(binding.value)
  return issueFakeResponse(c, {
    acsUrl: authn.acsUrl,
    audience: authn.issuer,
    inResponseTo: authn.id,
    relayState,
  })
})

fakeIdp.post('/sso', async (c) => {
  requireHarness(c)
  const form = await c.req.parseBody()
  const samlRequest = typeof form.SAMLRequest === 'string' ? form.SAMLRequest : ''
  const relayState = typeof form.RelayState === 'string' ? form.RelayState : undefined
  const binding = await decodeSamlBindingPayload(samlRequest, 'post')
  if (!binding.ok) throw new AppError('invalid_request', { longMessage: binding.error.reason })
  const authn = parseAuthnRequest(binding.value)
  return issueFakeResponse(c, {
    acsUrl: authn.acsUrl,
    audience: authn.issuer,
    inResponseTo: authn.id,
    relayState,
  })
})

fakeIdp.get('/certificate', (c) => {
  requireHarness(c)
  return c.json({ certificate: FAKE_IDP_CERT_B64, entityId: FAKE_IDP_ENTITY_ID })
})

export function registerFakeIdpRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/test/fake-idp/saml', fakeIdp)
}

export const FAKE_IDP_FIXTURE = {
  entityId: FAKE_IDP_ENTITY_ID,
  certificate: FAKE_IDP_CERT_B64,
  metadataPath: '/test/fake-idp/saml/metadata',
  ssoPath: '/test/fake-idp/saml/sso',
} as const
