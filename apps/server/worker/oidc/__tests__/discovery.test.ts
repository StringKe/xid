// discovery / jwks 端点测试:从 TenantContext 派生元数据 + KV 缓存;jwks 多 kid 公钥输出。
// issuer 多租户隔离(端点 URL 全部基于 ctx.issuer);二次请求命中 KV。

import { describe, it, expect } from 'vitest'
import { registerDiscoveryRoutes } from '../discovery'
import { registerJwksRoutes } from '../jwks'
import { registerProtectedResourceRoutes } from '../protected-resource'
import { buildTestTenant, makeApp, makeEnv, makeFakeKv } from './helpers'

describe('discovery endpoint', () => {
  it('openid-configuration 全字段基于 ctx.issuer + 合并 oauth-authorization-server', async () => {
    const { ctx } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({ CACHE: kv })
    const app = makeApp(ctx, registerDiscoveryRoutes)

    const oidc = await app.request('https://acme.xid.dev/.well-known/openid-configuration', {}, env)
    expect(oidc.status).toBe(200)
    const meta = (await oidc.json()) as Record<string, unknown>
    expect(meta['issuer']).toBe('https://acme.xid.dev')
    expect(meta['authorization_endpoint']).toBe('https://acme.xid.dev/authorize')
    expect(meta['token_endpoint']).toBe('https://acme.xid.dev/token')
    expect(meta['jwks_uri']).toBe('https://acme.xid.dev/jwks')
    expect(meta['code_challenge_methods_supported']).toEqual(['S256'])
    expect(meta['response_types_supported']).toEqual(['code', 'code id_token'])
    expect(meta['response_modes_supported']).toEqual([
      'query',
      'fragment',
      'form_post',
      'query.jwt',
      'fragment.jwt',
    ])
    expect(meta['request_parameter_supported']).toBe(true)
    expect(meta['request_uri_parameter_supported']).toBe(true)
    expect(meta['request_object_signing_alg_values_supported']).toContain('ES256')
    expect(meta['authorization_details_types_supported']).toEqual(['resource_access'])
    expect(meta['token_endpoint_auth_methods_supported']).toContain('tls_client_auth')
    expect(meta['token_endpoint_auth_methods_supported']).toContain('self_signed_tls_client_auth')
    expect(meta['tls_client_certificate_bound_access_tokens']).toBe(true)
    expect(meta['frontchannel_logout_supported']).toBe(true)
    expect(meta['frontchannel_logout_session_supported']).toBe(true)
    expect(meta['backchannel_logout_supported']).toBe(true)
    expect(meta['backchannel_logout_session_supported']).toBe(true)
    expect(meta['check_session_iframe']).toBe('https://acme.xid.dev/check_session')
    expect(meta['backchannel_authentication_endpoint']).toBe(
      'https://acme.xid.dev/backchannel_authentication',
    )
    expect(meta['federation_registration_endpoint']).toBe(
      'https://acme.xid.dev/federation_registration',
    )
    expect(meta['browser_based_apps_profile_supported']).toBe(false)
    expect(meta['fapi_profile_supported']).toBe(false)

    const oauth = await app.request(
      'https://acme.xid.dev/.well-known/oauth-authorization-server',
      {},
      env,
    )
    expect(await oauth.json()).toEqual(meta)
  })

  it('二次请求命中 KV 缓存(同响应)', async () => {
    const { ctx } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({ CACHE: kv })
    const app = makeApp(ctx, registerDiscoveryRoutes)
    const url = 'https://acme.xid.dev/.well-known/openid-configuration'
    const first = (await (await app.request(url, {}, env)).json()) as Record<string, unknown>
    const second = (await (await app.request(url, {}, env)).json()) as Record<string, unknown>
    expect(second).toEqual(first)
  })

  it('entry host 变化时不会复用旧 metadata 缓存且 issuer 保持 instance issuer', async () => {
    const { ctx } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({ CACHE: kv })
    const rootApp = makeApp({ ...ctx, issuer: 'https://xid.dev' }, registerDiscoveryRoutes)
    const defaultEntryApp = makeApp({ ...ctx, issuer: 'https://xid.dev' }, registerDiscoveryRoutes)

    const rootMeta = (await (
      await rootApp.request('https://xid.dev/.well-known/openid-configuration', {}, env)
    ).json()) as Record<string, unknown>
    const defaultEntryMeta = (await (
      await defaultEntryApp.request(
        'https://default.xid.dev/.well-known/openid-configuration',
        {},
        env,
      )
    ).json()) as Record<string, unknown>

    expect(rootMeta['issuer']).toBe('https://xid.dev')
    expect(defaultEntryMeta['issuer']).toBe('https://xid.dev')
    expect(defaultEntryMeta['jwks_uri']).toBe('https://xid.dev/jwks')
  })
})

describe('protected resource metadata endpoint', () => {
  it('oauth-protected-resource 全字段基于 ctx.issuer', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ CACHE: makeFakeKv() })
    const app = makeApp(ctx, registerProtectedResourceRoutes)

    const res = await app.request(
      'https://acme.xid.dev/.well-known/oauth-protected-resource',
      {},
      env,
    )
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta['resource']).toBe('https://acme.xid.dev')
    expect(meta['authorization_servers']).toEqual(['https://acme.xid.dev'])
    expect(meta['jwks_uri']).toBe('https://acme.xid.dev/jwks')
    expect(meta['bearer_methods_supported']).toEqual(['header'])
    expect(meta['dpop_signing_alg_values_supported']).toContain('ES256')
    expect(meta['resource_documentation']).toBe('https://acme.xid.dev/docs/oidc-oauth')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
  })

  it('oauth-protected-resource 二次请求命中 KV 缓存', async () => {
    const { ctx } = await buildTestTenant()
    const kv = makeFakeKv()
    const env = makeEnv({ CACHE: kv })
    const app = makeApp(ctx, registerProtectedResourceRoutes)
    const url = 'https://acme.xid.dev/.well-known/oauth-protected-resource'

    const first = (await (await app.request(url, {}, env)).json()) as Record<string, unknown>
    const second = (await (await app.request(url, {}, env)).json()) as Record<string, unknown>

    expect(second).toEqual(first)
  })
})

describe('jwks endpoint', () => {
  it('输出 active kid 公钥(use=sig, alg=ES256, 不含私钥参数)', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ CACHE: makeFakeKv() })
    const app = makeApp(ctx, registerJwksRoutes)
    const res = await app.request('https://acme.xid.dev/jwks', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Record<string, unknown>[] }
    expect(body.keys).toHaveLength(1)
    const key = body.keys[0] as Record<string, unknown>
    expect(key['kid']).toBe('kid-test')
    expect(key['use']).toBe('sig')
    expect(key['alg']).toBe('ES256')
    expect(key['d']).toBeUndefined()
  })
})
