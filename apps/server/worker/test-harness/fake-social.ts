// Fake Social OAuth provider for local L3 smoke (Google/Apple/Microsoft/GitHub shapes).

import { base64UrlEncode, exportPublicJwk, signJwt } from '@xid-kit/crypto'
import type { PublicJwk } from '@xid-kit/crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { isDevOrTestEnvironment } from './dev-gate'

type FakeSocialProfile = {
  sub: string
  email: string
  email_verified: boolean
  name: string
  given_name?: string
  family_name?: string
  login?: string
}

type PendingCode = { provider: string; redirectUri: string; state: string; nonce?: string }

const pendingCodes = new Map<string, PendingCode>()

function pendingKey(tenantId: string, code: string): string {
  return `${tenantId}:${code}`
}

type FakeSocialKeyMaterial = {
  privateKey: CryptoKey
  jwk: PublicJwk
}

const keyMaterialByProvider = new Map<string, Promise<FakeSocialKeyMaterial>>()

async function keyMaterialFor(provider: string): Promise<FakeSocialKeyMaterial> {
  let pending = keyMaterialByProvider.get(provider)
  if (!pending) {
    pending = (async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ])
      const jwk = await exportPublicJwk(pair.publicKey, `fake-${provider}`, 'ES256')
      return { privateKey: pair.privateKey, jwk }
    })()
    keyMaterialByProvider.set(provider, pending)
  }
  return pending
}

function requireHarness(c: Context<XidHonoEnv>): void {
  if (!isDevOrTestEnvironment(c.env)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}

function profileFor(provider: string): FakeSocialProfile {
  const base = {
    sub: `fake-${provider}-123`,
    email: `${provider}.user@example.com`,
    email_verified: true,
    name: `Fake ${provider} User`,
  }
  if (provider === 'github') {
    return { ...base, login: 'fake-github-user' }
  }
  if (provider === 'google' || provider === 'microsoft' || provider === 'apple') {
    return { ...base, given_name: 'Fake', family_name: provider }
  }
  return base
}

async function issueIdToken(
  c: Context<XidHonoEnv>,
  provider: string,
  profile: FakeSocialProfile,
  nonce?: string,
): Promise<string> {
  const issuer = `${c.get('tenant').issuer}/test/fake-social/${provider}`
  const material = await keyMaterialFor(provider)
  const kid = material.jwk.kid ?? `fake-${provider}`
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    {
      header: { alg: 'ES256', kid },
      payload: {
        iss: issuer,
        aud: 'fake-social-client',
        sub: profile.sub,
        email: profile.email,
        email_verified: profile.email_verified,
        name: profile.name,
        ...(nonce ? { nonce } : {}),
        iat: now,
        exp: now + 300,
      },
    },
    material.privateKey,
  )
}

const fakeSocial = new Hono<XidHonoEnv>()

fakeSocial.get('/:provider/authorize', async (c) => {
  requireHarness(c)
  const provider = c.req.param('provider')
  const redirectUri = c.req.query('redirect_uri') ?? ''
  const state = c.req.query('state') ?? ''
  const nonce = c.req.query('nonce') ?? undefined
  if (!redirectUri || !state) {
    throw new AppError('invalid_request', { longMessage: 'redirect_uri and state required' })
  }
  const code = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
  const tenantId = c.get('tenant').tenantId
  pendingCodes.set(pendingKey(tenantId, code), { provider, redirectUri, state, nonce })
  if (provider === 'apple') {
    const html = `<!DOCTYPE html><html><body onload="document.forms[0].submit()"><form method="POST" action="${redirectUri}"><input type="hidden" name="code" value="${code}" /><input type="hidden" name="state" value="${state}" /></form></body></html>`
    return c.html(html, 200)
  }
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  url.searchParams.set('state', state)
  return c.redirect(url.toString(), 302)
})

fakeSocial.post('/:provider/token', async (c) => {
  requireHarness(c)
  const provider = c.req.param('provider')
  const body = await c.req.parseBody()
  const code = typeof body.code === 'string' ? body.code : ''
  const tenantId = c.get('tenant').tenantId
  const pending = pendingCodes.get(pendingKey(tenantId, code))
  if (!pending || pending.provider !== provider) {
    throw new AppError('invalid_grant', { longMessage: 'invalid authorization code' })
  }
  pendingCodes.delete(pendingKey(tenantId, code))
  const profile = profileFor(provider)
  const idToken = await issueIdToken(c, provider, profile, pending.nonce)
  return c.json({
    access_token: `fake-${provider}-access`,
    token_type: 'Bearer',
    expires_in: 3600,
    id_token: idToken,
    scope: 'openid email profile',
  })
})

fakeSocial.get('/:provider/userinfo', async (c) => {
  requireHarness(c)
  const provider = c.req.param('provider')
  const profile = profileFor(provider)
  if (provider === 'github') {
    return c.json({ id: 12345, login: profile.login, name: profile.name })
  }
  return c.json({
    sub: profile.sub,
    email: profile.email,
    email_verified: profile.email_verified,
    name: profile.name,
    given_name: profile.given_name,
    family_name: profile.family_name,
  })
})

fakeSocial.get('/:provider/.well-known/openid-configuration', (c) => {
  requireHarness(c)
  const provider = c.req.param('provider')
  const issuer = `${c.get('tenant').issuer}/test/fake-social/${provider}`
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
  })
})

fakeSocial.get('/:provider/jwks', async (c) => {
  requireHarness(c)
  const provider = c.req.param('provider')
  const material = await keyMaterialFor(provider)
  return c.json({ keys: [material.jwk] })
})

export function registerFakeSocialRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/test/fake-social', fakeSocial)
}

export function fakeSocialProviderConfig(
  issuer: string,
  provider: string,
): {
  authorizationEndpoint: string
  tokenEndpoint: string
  userInfoEndpoint: string
  issuer: string
  jwksUri: string
  scopes: string[]
  usesPkce: boolean
} {
  const base = `${issuer}/test/fake-social/${provider}`
  return {
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    userInfoEndpoint: `${base}/userinfo`,
    issuer: base,
    jwksUri: `${base}/jwks`,
    scopes: ['openid', 'email', 'profile'],
    usesPkce: true,
  }
}
