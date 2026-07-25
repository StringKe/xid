// social-providers.ts 单元测试:provider OIDC id_token 验签和 claims 提取。

import { describe, expect, it, vi } from 'vitest'
import { exportPublicJwk, signJwt } from '@xid-kit/crypto'
import { generateTenantSigningKey } from '@xid-kit/crypto'
import type { ProviderConfig } from '../social-providers'
import {
  assertPublicProviderEndpoints,
  exchangeCode,
  GITHUB_EMU_ISSUER_BOUNDARIES,
  isGithubEmuIssuer,
  resolveProfile,
} from '../social-providers'
import { isHostedAuthPolicyError } from '../hosted-policy'

function makeKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  } as unknown as KVNamespace
}

async function setupProviderJwt(input: {
  issuer: string
  audience: string
  nonce: string
  claims?: Record<string, unknown>
}) {
  const { material, signingKey } = await generateTenantSigningKey({
    kid: 'provider-kid',
    kekRaw: crypto.getRandomValues(new Uint8Array(32)),
    kekVersion: 1,
    alg: 'ES256',
  })
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    material.publicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  )
  const jwk = await exportPublicJwk(publicKey, material.kid, material.alg)
  const now = Math.floor(Date.now() / 1000)
  const idToken = await signJwt(
    {
      header: { alg: 'ES256', kid: material.kid },
      payload: {
        iss: input.issuer,
        aud: input.audience,
        exp: now + 300,
        iat: now,
        nonce: input.nonce,
        sub: 'provider-user-1',
        email: 'user@example.com',
        email_verified: true,
        name: 'Provider User',
        ...input.claims,
      },
    },
    signingKey,
  )
  return { idToken, jwks: { keys: [jwk] } }
}

function makeConfig(input: { issuer: string; jwksUri: string; clientId: string }): ProviderConfig {
  return {
    authorizationEndpoint: `${input.issuer}/authorize`,
    tokenEndpoint: `${input.issuer}/token`,
    clientId: input.clientId,
    clientSecret: 'secret',
    scopes: ['openid', 'email', 'profile'],
    usesPkce: true,
    issuer: input.issuer,
    jwksUri: input.jwksUri,
    redirectUris: ['/account'],
  }
}

describe('GitHub EMU OIDC preset', () => {
  it('accepts GitHub Actions issuer globally and Entra issuer when configured', () => {
    expect(isGithubEmuIssuer('https://token.actions.githubusercontent.com')).toBe(true)
    expect(isGithubEmuIssuer('https://login.microsoftonline.com/tenant/v2.0')).toBe(false)
    expect(
      isGithubEmuIssuer('https://login.microsoftonline.com/emu-tenant/v2.0', {
        authorizationEndpoint:
          'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
        tokenEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
        clientId: 'client',
        scopes: ['openid'],
        usesPkce: true,
        issuer: 'https://login.microsoftonline.com/emu-tenant/v2.0',
        jwksUri: 'https://login.microsoftonline.com/emu-tenant/discovery/v2.0/keys',
      }),
    ).toBe(true)
    expect(GITHUB_EMU_ISSUER_BOUNDARIES).toContain('https://token.actions.githubusercontent.com')
  })

  it('github_emu id_token maps external_id claim to profile.externalId', async () => {
    const issuer = 'https://login.microsoftonline.com/emu-tenant/v2.0'
    const jwksUri = 'https://login.microsoftonline.com/emu-tenant/discovery/v2.0/keys'
    const clientId = 'github-emu-client'
    const nonce = 'github-emu-nonce'
    const { idToken, jwks } = await setupProviderJwt({
      issuer,
      audience: clientId,
      nonce,
      claims: {
        external_id: 'emu-user-42',
        email: 'emu@example.com',
        email_verified: true,
        name: 'EMU User',
      },
    })
    const env = { CACHE: makeKv() } as unknown as Env
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })),
    )

    const profile = await resolveProfile({
      env,
      provider: 'github_emu',
      config: {
        ...makeConfig({ issuer, jwksUri, clientId }),
        externalIdClaim: 'external_id',
      },
      tokens: { accessToken: 'access-token', refreshToken: null, idToken },
      nonce,
    })

    expect(profile).toMatchObject({
      idpUserId: 'provider-user-1',
      externalId: 'emu-user-42',
      email: 'emu@example.com',
    })

    vi.unstubAllGlobals()
  })

  it('github_emu rejects id_token outside EMU issuer boundaries', async () => {
    const issuer = 'https://evil.example.com'
    const jwksUri = 'https://evil.example.com/keys'
    const clientId = 'github-emu-client'
    const nonce = 'github-emu-nonce'
    const { idToken, jwks } = await setupProviderJwt({
      issuer,
      audience: clientId,
      nonce,
    })
    const env = { CACHE: makeKv() } as unknown as Env
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })),
    )

    await expect(
      resolveProfile({
        env,
        provider: 'github_emu',
        config: {
          ...makeConfig({
            issuer: 'https://login.microsoftonline.com/allowed-tenant/v2.0',
            jwksUri,
            clientId,
          }),
        },
        tokens: { accessToken: 'access-token', refreshToken: null, idToken },
        nonce,
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })

    vi.unstubAllGlobals()
  })
})

describe('resolveProfile OIDC providers', () => {
  it('Apple id_token 验签后保留 private relay email claims', async () => {
    const issuer = 'https://appleid.apple.com'
    const jwksUri = 'https://appleid.apple.com/auth/keys'
    const clientId = 'apple-client'
    const nonce = 'apple-nonce'
    const { idToken, jwks } = await setupProviderJwt({
      issuer,
      audience: clientId,
      nonce,
      claims: {
        email: 'relay@privaterelay.appleid.com',
        email_verified: 'true',
        name: 'Apple User',
      },
    })
    const env = { CACHE: makeKv() } as unknown as Env
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })),
    )

    const profile = await resolveProfile({
      env,
      provider: 'apple',
      config: makeConfig({ issuer, jwksUri, clientId }),
      tokens: { accessToken: 'access-token', refreshToken: null, idToken },
      nonce,
    })

    expect(profile).toMatchObject({
      idpUserId: 'provider-user-1',
      email: 'relay@privaterelay.appleid.com',
      emailVerified: true,
      name: 'Apple User',
    })
    expect(profile.profileRaw['nonce']).toBe(nonce)
    expect(fetch).toHaveBeenCalledWith(jwksUri)

    vi.unstubAllGlobals()
  })

  it('Microsoft id_token 验签后提取 OIDC profile email claims', async () => {
    const issuer = 'https://login.microsoftonline.com/consumers/v2.0'
    const jwksUri = 'https://login.microsoftonline.com/consumers/discovery/v2.0/keys'
    const clientId = 'microsoft-client'
    const nonce = 'microsoft-nonce'
    const { idToken, jwks } = await setupProviderJwt({
      issuer,
      audience: clientId,
      nonce,
      claims: {
        email: 'user@outlook.com',
        email_verified: true,
        name: 'Microsoft User',
      },
    })
    const env = { CACHE: makeKv() } as unknown as Env
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })),
    )

    const profile = await resolveProfile({
      env,
      provider: 'microsoft',
      config: makeConfig({ issuer, jwksUri, clientId }),
      tokens: { accessToken: 'access-token', refreshToken: null, idToken },
      nonce,
    })

    expect(profile).toMatchObject({
      idpUserId: 'provider-user-1',
      email: 'user@outlook.com',
      emailVerified: true,
      name: 'Microsoft User',
    })
    expect(profile.profileRaw['iss']).toBe(issuer)
    expect(fetch).toHaveBeenCalledWith(jwksUri)

    vi.unstubAllGlobals()
  })
})

describe('provider 端点 SSRF 防护(消费侧)', () => {
  it('assertPublicProviderEndpoints 放行公网端点,拒绝内网/明文端点并抛 policy 错误(供审计)', () => {
    const base = makeConfig({
      issuer: 'https://issuer.example.com',
      jwksUri: 'https://issuer.example.com/keys',
      clientId: 'client',
    })
    expect(() => assertPublicProviderEndpoints(base)).not.toThrow()

    for (const bad of [
      { ...base, tokenEndpoint: 'http://169.254.169.254/token' },
      { ...base, jwksUri: 'https://192.168.1.1/keys' },
      { ...base, authorizationEndpoint: 'https://127.0.0.1/authorize' },
      { ...base, userInfoEndpoint: 'https://10.0.0.1/userinfo' },
    ]) {
      try {
        assertPublicProviderEndpoints(bad)
        expect.unreachable('expected HostedAuthPolicyError')
      } catch (error) {
        expect(isHostedAuthPolicyError(error)).toBe(true)
        expect((error as { code: string }).code).toBe('invalid_request')
      }
    }
  })

  it('exchangeCode 拒绝内网 tokenEndpoint,不发起 fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const config = makeConfig({
      issuer: 'https://issuer.example.com',
      jwksUri: 'https://issuer.example.com/keys',
      clientId: 'client',
    })
    config.tokenEndpoint = 'https://169.254.169.254/latest/meta-data'

    await expect(
      exchangeCode({
        provider: 'custom',
        config,
        redirectUri: 'https://xid.dev/auth/custom/callback',
        codeVerifier: 'verifier',
        code: 'code',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('resolveProfile 拒绝内网 jwksUri,不发起 fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const env = { CACHE: makeKv() } as unknown as Env
    const config = makeConfig({
      issuer: 'https://issuer.example.com',
      jwksUri: 'http://127.0.0.1/keys',
      clientId: 'client',
    })

    await expect(
      resolveProfile({
        env,
        provider: 'custom',
        config,
        tokens: { accessToken: 'at', refreshToken: null, idToken: 'a.b.c' },
        nonce: 'n',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
