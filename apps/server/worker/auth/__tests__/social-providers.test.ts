// social-providers.ts 单元测试:provider OIDC id_token 验签和 claims 提取。

import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../social-providers'
import {
  assertPublicProviderEndpoints,
  exchangeCode,
  GITHUB_EMU_ISSUER_BOUNDARIES,
  isGithubEmuIssuer,
  socialProviderConfigIssue,
  socialProviderSecretBinding,
} from '../social-providers'
import { resolveProfile } from '../social-profile'
import type { SocialProviderPolicy } from '@xid-kit/types'
import { isHostedAuthPolicyError } from '../hosted-policy'
import { makeConfig, makeKv, setupProviderJwt } from './social-test-helpers'

describe('social provider secret binding allowlist', () => {
  it('uses fixed built-in bindings and ignores tenant-adjacent arbitrary Env keys', () => {
    const env = {
      GOOGLE_CLIENT_SECRET: 'google-secret',
      KEK: 'must-not-be-addressable',
    } as unknown as Env

    expect(socialProviderSecretBinding(env, 'google')).toBe('GOOGLE_CLIENT_SECRET')
    expect(socialProviderSecretBinding(env, 'KEK')).toBeUndefined()
  })

  it('allows custom providers only through an operator mapping with the social secret prefix', () => {
    const env = {
      SOCIAL_PROVIDER_SECRET_BINDINGS: JSON.stringify({
        acme: 'SOCIAL_ACME_CLIENT_SECRET',
        unsafe: 'KEK',
      }),
      SOCIAL_ACME_CLIENT_SECRET: 'custom-secret',
      KEK: 'must-not-be-addressable',
    } as unknown as Env

    expect(socialProviderSecretBinding(env, 'acme')).toBe('SOCIAL_ACME_CLIENT_SECRET')
    expect(socialProviderSecretBinding(env, 'unsafe')).toBeUndefined()
  })
})

function makeGitHubConfig(): ProviderConfig {
  return {
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    userInfoEndpoint: 'https://api.github.com/user',
    clientId: 'github-client',
    clientSecret: 'github-secret',
    scopes: ['read:user', 'user:email'],
    usesPkce: true,
  }
}

describe('GitHub non-OIDC Email proof', () => {
  it('uses the primary verified /user/emails address and ignores public profile verification hints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 42,
          name: 'GitHub User',
          email: 'public@example.com',
          email_verified: true,
        })
      }
      if (url === 'https://api.github.com/user/emails') {
        return Response.json([
          {
            email: 'public@example.com',
            primary: false,
            verified: true,
            visibility: 'public',
          },
          {
            email: 'primary@example.com',
            primary: true,
            verified: true,
            visibility: 'private',
          },
        ])
      }
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const profile = await resolveProfile({
      env: {} as Env,
      provider: 'github',
      config: makeGitHubConfig(),
      tokens: { accessToken: 'github-access-token', refreshToken: null, idToken: null },
      nonce: 'unused-for-github',
    })

    expect(profile).toMatchObject({
      idpUserId: '42',
      email: 'primary@example.com',
      emailVerified: true,
      name: 'GitHub User',
    })
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.github.com/user',
      'https://api.github.com/user/emails',
    ])
    vi.unstubAllGlobals()
  })

  it('bounds every GitHub profile request with a timeout signal', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input) === 'https://api.github.com/user'
        ? Response.json({ id: 42, name: 'GitHub User' })
        : Response.json([{ email: 'primary@example.com', primary: true, verified: true }]),
    )
    vi.stubGlobal('fetch', fetchMock)

    await resolveProfile({
      env: {} as Env,
      provider: 'github',
      config: makeGitHubConfig(),
      tokens: { accessToken: 'github-access-token', refreshToken: null, idToken: null },
      nonce: 'unused-for-github',
    })

    expect(fetchMock.mock.calls).toHaveLength(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    vi.unstubAllGlobals()
  })

  it('does not use a public profile Email or a non-primary verified address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url === 'https://api.github.com/user') {
          return Response.json({
            id: 42,
            name: 'GitHub User',
            email: 'public@example.com',
          })
        }
        if (url === 'https://api.github.com/user/emails') {
          return Response.json([
            { email: 'public@example.com', primary: true, verified: false },
            { email: 'secondary@example.com', primary: false, verified: true },
          ])
        }
        return new Response(null, { status: 404 })
      }),
    )

    const profile = await resolveProfile({
      env: {} as Env,
      provider: 'github',
      config: makeGitHubConfig(),
      tokens: { accessToken: 'github-access-token', refreshToken: null, idToken: null },
      nonce: 'unused-for-github',
    })

    expect(profile.email).toBeNull()
    expect(profile.emailVerified).toBe(false)
    vi.unstubAllGlobals()
  })

  it('fails closed when /user/emails is unavailable instead of trusting public profile Email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url === 'https://api.github.com/user') {
          return Response.json({
            id: 42,
            name: 'GitHub User',
            email: 'public@example.com',
          })
        }
        return new Response(null, { status: 403 })
      }),
    )

    await expect(
      resolveProfile({
        env: {} as Env,
        provider: 'github',
        config: makeGitHubConfig(),
        tokens: { accessToken: 'github-access-token', refreshToken: null, idToken: null },
        nonce: 'unused-for-github',
      }),
    ).rejects.toMatchObject({ code: 'internal_error' })
    vi.unstubAllGlobals()
  })
})

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
    expect(fetch).toHaveBeenCalledWith(jwksUri, { signal: expect.any(AbortSignal) })

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
    expect(fetch).toHaveBeenCalledWith(jwksUri, { signal: expect.any(AbortSignal) })

    vi.unstubAllGlobals()
  })
})

describe('Microsoft Entra 多租户 id_token', () => {
  const TEMPLATE = 'https://login.microsoftonline.com/{tenantid}/v2.0'
  const JWKS_URI = 'https://login.microsoftonline.com/common/discovery/v2.0/keys'
  const TID = '9188040d-6c67-4c5b-b112-36a304b66dad'

  async function resolveMicrosoft(input: { iss: string; tid: unknown }) {
    const clientId = 'microsoft-client'
    const nonce = 'microsoft-nonce'
    const { idToken, jwks } = await setupProviderJwt({
      issuer: input.iss,
      audience: clientId,
      nonce,
      alg: 'RS256',
      claims: { tid: input.tid },
    })
    const keysWithoutAlg = jwks.keys.map(({ alg: _alg, use: _use, ...key }) => key)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ keys: keysWithoutAlg })),
    )
    try {
      return await resolveProfile({
        env: { CACHE: makeKv() } as unknown as Env,
        provider: 'microsoft',
        config: makeConfig({ issuer: TEMPLATE, jwksUri: JWKS_URI, clientId }),
        tokens: { accessToken: 'access-token', refreshToken: null, idToken },
        nonce,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('JWKS key 不带 alg 时按 kty 推断 RS256,并用 tid 代入 issuer 模板后精确校验', async () => {
    const profile = await resolveMicrosoft({
      iss: `https://login.microsoftonline.com/${TID}/v2.0`,
      tid: TID,
    })

    expect(profile.idpUserId).toBe('provider-user-1')
  })

  it('iss 与 tid 代入后的 issuer 不一致 -> invalid_credentials', async () => {
    await expect(
      resolveMicrosoft({
        iss: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0',
        tid: TID,
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
  })

  it('tid 不是 Entra 租户 GUID -> invalid_credentials', async () => {
    await expect(
      resolveMicrosoft({ iss: 'https://login.microsoftonline.com/evil/v2.0', tid: 'evil' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
  })
})

describe('非 OIDC 自定义 provider userinfo', () => {
  it('无 id_token 时读取 userinfo,只有 email_verified === true 才算已验证', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ sub: 'custom-1', email: 'u@example.com', email_verified: 'true' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const profile = await resolveProfile({
      env: {} as Env,
      provider: 'acme',
      config: {
        ...makeGitHubConfig(),
        userInfoEndpoint: 'https://id.acme.example/userinfo',
      },
      tokens: { accessToken: 'at', refreshToken: null, idToken: null },
      nonce: 'unused',
    })

    expect(profile).toMatchObject({
      idpUserId: 'custom-1',
      email: 'u@example.com',
      emailVerified: false,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://id.acme.example/userinfo',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    vi.unstubAllGlobals()
  })

  it('userinfo 缺 sub -> invalid_credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ email: 'u@example.com' })),
    )

    await expect(
      resolveProfile({
        env: {} as Env,
        provider: 'acme',
        config: { ...makeGitHubConfig(), userInfoEndpoint: 'https://id.acme.example/userinfo' },
        tokens: { accessToken: 'at', refreshToken: null, idToken: null },
        nonce: 'unused',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    vi.unstubAllGlobals()
  })

  it('配置了 issuer 与 JWKS 的 OIDC provider 缺 id_token 时拒绝,不降级到 userinfo', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ sub: 'custom-1', email: 'u@example.com', email_verified: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      resolveProfile({
        env: {} as Env,
        provider: 'acme',
        config: {
          ...makeGitHubConfig(),
          issuer: 'https://id.acme.example',
          jwksUri: 'https://id.acme.example/jwks',
          userInfoEndpoint: 'https://id.acme.example/userinfo',
        },
        tokens: { accessToken: 'at', refreshToken: null, idToken: null },
        nonce: 'expected-nonce',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })

    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('socialProviderConfigIssue', () => {
  function policy(overrides: Record<string, unknown> = {}): SocialProviderPolicy {
    return {
      authorizationEndpoint: 'https://idp.example/authorize',
      tokenEndpoint: 'https://idp.example/token',
      clientId: 'client',
      scopes: ['openid'],
      usesPkce: true,
      enabled: true,
      allowLogin: true,
      allowUserCreation: false,
      requireVerifiedEmail: true,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
      ...overrides,
    } as SocialProviderPolicy
  }

  it('启用的 OIDC provider 缺 issuer 或 JWKS 且无 userinfo 时拒绝保存', () => {
    expect(socialProviderConfigIssue('acme', policy())).toBe('issuer')
    expect(socialProviderConfigIssue('acme', policy({ issuer: 'https://idp.example' }))).toBe(
      'jwksUri',
    )
  })

  it('接受完整 OIDC 配置、userinfo 配置、GitHub 与未启用的模板', () => {
    expect(
      socialProviderConfigIssue(
        'acme',
        policy({ issuer: 'https://idp.example', jwksUri: 'https://idp.example/keys' }),
      ),
    ).toBeNull()
    expect(
      socialProviderConfigIssue('acme', policy({ userInfoEndpoint: 'https://idp.example/me' })),
    ).toBeNull()
    expect(socialProviderConfigIssue('github', policy())).toBeNull()
    expect(socialProviderConfigIssue('acme', policy({ enabled: false }))).toBeNull()
  })

  it('只允许 Microsoft issuer 保留 {tenantid} 占位,其余占位一律拒绝', () => {
    const entra = {
      issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
      jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    }
    expect(socialProviderConfigIssue('microsoft', policy(entra))).toBeNull()
    expect(socialProviderConfigIssue('github_emu', policy(entra))).toBe('issuer')
    expect(
      socialProviderConfigIssue(
        'microsoft',
        policy({ ...entra, issuer: 'https://login.microsoftonline.com/{tenant-id}/v2.0' }),
      ),
    ).toBe('issuer')
    expect(
      socialProviderConfigIssue(
        'acme',
        policy({ ...entra, issuer: 'https://idp.example', jwksUri: 'https://idp/{x}/keys' }),
      ),
    ).toBe('jwksUri')
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
