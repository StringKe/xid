import { describe, expect, it, vi } from 'vitest'

import { xidIntegration } from '../integration'
import type { XidIntegrationOptions } from '../types'

const JWT_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'mock-x',
  y: 'mock-y',
  kid: 'kid_test',
  use: 'sig',
  alg: 'ES256',
} as const

function setupIntegration(options: XidIntegrationOptions, output: 'static' | 'server' | 'hybrid') {
  const integration = xidIntegration(options)
  const setup = integration.hooks['astro:config:setup']
  if (!setup) throw new Error('astro:config:setup hook is missing')

  const addMiddleware = vi.fn()
  const injectScript = vi.fn()
  const updateConfig = vi.fn()
  setup({
    addMiddleware,
    injectScript,
    updateConfig,
    config: { output },
  })
  return { addMiddleware, injectScript, updateConfig }
}

describe('xidIntegration', () => {
  it('injects real browser OIDC config without exposing server options', () => {
    const hooks = setupIntegration(
      {
        browser: {
          mode: 'oidc',
          issuer: 'https://xid.dev',
          clientId: 'client_public',
          redirectUri: 'https://app.example/callback',
        },
        jwtKey: JWT_KEY,
        issuer: 'https://server-only.example',
      },
      'server',
    )

    expect(hooks.injectScript).toHaveBeenCalledWith(
      'head-inline',
      'window.__XID_CONFIG={"mode":"oidc","issuer":"https://xid.dev","clientId":"client_public","redirectUri":"https://app.example/callback"};',
    )
    const browserSource = String(hooks.injectScript.mock.calls[0]?.[1])
    expect(browserSource).not.toContain('jwtKey')
    expect(browserSource).not.toContain('server-only.example')
    expect(browserSource).not.toContain('kid_test')
  })

  it('registers configured auth middleware through a server-only virtual module', () => {
    const hooks = setupIntegration(
      {
        jwtKey: JWT_KEY,
        issuer: 'https://xid.dev',
        sessionTokenExchange: { endpoint: '/v1/sessions/token' },
        protectedRoutes: ['/dashboard'],
      },
      'server',
    )

    expect(hooks.addMiddleware).toHaveBeenCalledWith({
      entrypoint: '@xid-kit/astro/integration-middleware',
      order: 'pre',
    })

    const update = hooks.updateConfig.mock.calls[0]?.[0] as {
      vite: {
        plugins: Array<{
          resolveId(id: string): string | undefined
          load(id: string): string | undefined
        }>
      }
    }
    const plugin = update.vite.plugins[0]
    const resolved = plugin?.resolveId('virtual:@xid-kit/astro:config')
    expect(resolved).toBe('\0virtual:@xid-kit/astro:config')
    const source = plugin?.load(resolved ?? '')
    expect(source).toContain('"endpoint":"/v1/sessions/token"')
    expect(source).toContain('"protectedRoutes":["/dashboard"]')
    expect(source).not.toContain('client_public')
  })

  it('supports client-only integration on static output', () => {
    const hooks = setupIntegration(
      {
        browser: {
          mode: 'oidc',
          issuer: 'https://xid.dev',
          clientId: 'client_public',
          redirectUri: 'https://app.example/callback',
        },
      },
      'static',
    )

    expect(hooks.injectScript).toHaveBeenCalledOnce()
    expect(hooks.addMiddleware).not.toHaveBeenCalled()
    expect(hooks.updateConfig).not.toHaveBeenCalled()
  })

  it('rejects auth configuration on static output', () => {
    expect(() =>
      setupIntegration(
        {
          jwtKey: JWT_KEY,
        },
        'static',
      ),
    ).toThrow('requires Astro output "server" or "hybrid"')
  })

  it('rejects server options without jwtKey', () => {
    expect(() =>
      setupIntegration(
        {
          protectedRoutes: ['/dashboard'],
        },
        'server',
      ),
    ).toThrow('requires jwtKey')
  })

  it('rejects imported CryptoKey values at the build boundary', () => {
    const importedKey = {
      alg: 'ES256',
      publicKey: {} as CryptoKey,
    }

    expect(() =>
      xidIntegration({
        jwtKey: importedKey as never,
      }),
    ).toThrow('serializable public JWK or JWKS')
  })

  it('rejects runtime exchange hooks at the build boundary', () => {
    expect(() =>
      xidIntegration({
        jwtKey: JWT_KEY,
        sessionTokenExchange: {
          endpoint: '/v1/sessions/token',
          fetcher: vi.fn(),
        } as never,
      }),
    ).toThrow('supports endpoint only')
  })

  it('rejects runtime-only browser hooks at the build boundary', () => {
    expect(() =>
      xidIntegration({
        browser: {
          mode: 'oidc',
          issuer: 'https://xid.dev',
          clientId: 'client_public',
          redirectUri: 'https://app.example/callback',
          tokenCache: {},
        } as never,
      }),
    ).toThrow('serializable public client options only')
  })
})
