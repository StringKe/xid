import { describe, it, expect } from 'vitest'

import { buildDiscoveryMetadata, buildProtectedResourceMetadata } from '../discovery'
import { buildTestTenant } from './fixtures/tenant'

describe('buildDiscoveryMetadata', () => {
  it('derives issuer and endpoints from TenantContext', async () => {
    const { ctx } = await buildTestTenant({ issuer: 'https://acme.xid.dev' })
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.issuer).toBe('https://acme.xid.dev')
    expect(meta.authorization_endpoint).toBe('https://acme.xid.dev/authorize')
    expect(meta.token_endpoint).toBe('https://acme.xid.dev/token')
    expect(meta.jwks_uri).toBe('https://acme.xid.dev/jwks')
    expect(meta.pushed_authorization_request_endpoint).toBe('https://acme.xid.dev/par')
  })

  it('advertises only S256 code_challenge method (rejects plain)', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('advertises hybrid response type and JAR request object signing support', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.response_types_supported).toEqual(['code', 'code id_token'])
    expect(meta.response_modes_supported).toEqual([
      'query',
      'fragment',
      'form_post',
      'query.jwt',
      'fragment.jwt',
    ])
    expect(meta.request_parameter_supported).toBe(true)
    expect(meta.request_uri_parameter_supported).toBe(true)
    // request object 验签接受 SigningAlg 全集,不随服务器密钥集。
    expect(meta.request_object_signing_alg_values_supported).toEqual(['ES256', 'RS256', 'PS256'])
    expect(meta.authorization_details_types_supported).toEqual(['resource_access'])
  })

  it('reports signing alg from active key set', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.id_token_signing_alg_values_supported).toContain('ES256')
    // DPoP 验签白名单不随服务器密钥集。
    expect(meta.dpop_signing_alg_values_supported).toEqual(['ES256', 'RS256', 'PS256'])
  })

  it('does not advertise ssf endpoint (501 stub, unsupported)', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect('ssf_configuration_endpoint' in meta).toBe(false)
  })

  it('scopes_supported matches real semantics (organization in, address out)', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.scopes_supported).toContain('organization')
    expect(meta.scopes_supported).toContain('phone')
    expect(meta.scopes_supported).not.toContain('address')
  })

  it('claims_supported matches userinfo/id-token output (profile+phone+sid in)', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    for (const claim of [
      'given_name',
      'family_name',
      'preferred_username',
      'picture',
      'locale',
      'zoneinfo',
      'phone_number',
      'phone_number_verified',
      'sid',
    ]) {
      expect(meta.claims_supported).toContain(claim)
    }
  })

  it('advertises RFC9207 authorization_response_iss_parameter_supported', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.authorization_response_iss_parameter_supported).toBe(true)
  })

  it('advertises mTLS client authentication methods by default', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.token_endpoint_auth_methods_supported).toContain('tls_client_auth')
    expect(meta.token_endpoint_auth_methods_supported).toContain('self_signed_tls_client_auth')
    expect(meta.tls_client_certificate_bound_access_tokens).toBe(true)
  })

  it('can hide mTLS when mtlsSupported=false', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx, mtlsSupported: false })
    expect(meta.token_endpoint_auth_methods_supported).not.toContain('tls_client_auth')
    expect(meta.tls_client_certificate_bound_access_tokens).toBe(false)
  })

  it('advertises optional OIDC profile endpoints', async () => {
    const { ctx } = await buildTestTenant()
    const meta = buildDiscoveryMetadata({ ctx })
    expect(meta.frontchannel_logout_supported).toBe(true)
    expect(meta.backchannel_logout_supported).toBe(true)
    expect(meta.backchannel_logout_session_supported).toBe(true)
    expect(meta.check_session_iframe).toBe(`${ctx.issuer}/check_session`)
    expect(meta.backchannel_authentication_endpoint).toBe(
      `${ctx.issuer}/backchannel_authentication`,
    )
    expect(meta.federation_registration_endpoint).toBe(`${ctx.issuer}/federation_registration`)
    expect(meta.browser_based_apps_profile_supported).toBe(false)
    expect(meta.fapi_profile_supported).toBe(false)
  })

  it('isolates issuer per tenant', async () => {
    const a = await buildTestTenant({ issuer: 'https://a.xid.dev' })
    const b = await buildTestTenant({ issuer: 'https://b.xid.dev' })
    const ma = buildDiscoveryMetadata({ ctx: a.ctx })
    const mb = buildDiscoveryMetadata({ ctx: b.ctx })
    expect(ma.token_endpoint).not.toBe(mb.token_endpoint)
  })

  it('require_pushed_authorization_requests reflects flag', async () => {
    const { ctx } = await buildTestTenant()
    expect(buildDiscoveryMetadata({ ctx }).require_pushed_authorization_requests).toBe(false)
    expect(
      buildDiscoveryMetadata({ ctx, requirePar: true }).require_pushed_authorization_requests,
    ).toBe(true)
  })
})

describe('buildProtectedResourceMetadata', () => {
  it('derives RFC9728 resource metadata from TenantContext', async () => {
    const { ctx } = await buildTestTenant({ issuer: 'https://acme.xid.dev' })
    const meta = buildProtectedResourceMetadata({ ctx })

    expect(meta.resource).toBe('https://acme.xid.dev')
    expect(meta.authorization_servers).toEqual(['https://acme.xid.dev'])
    expect(meta.jwks_uri).toBe('https://acme.xid.dev/jwks')
    expect(meta.bearer_methods_supported).toEqual(['header'])
    expect(meta.dpop_signing_alg_values_supported).toEqual(['ES256', 'RS256', 'PS256'])
    expect(meta.resource_documentation).toBe('https://xid.dev/oidc-oauth')
  })

  it('isolates protected resource metadata issuer per tenant', async () => {
    const a = await buildTestTenant({ issuer: 'https://a.xid.dev' })
    const b = await buildTestTenant({ issuer: 'https://b.xid.dev' })

    expect(buildProtectedResourceMetadata({ ctx: a.ctx }).resource).toBe('https://a.xid.dev')
    expect(buildProtectedResourceMetadata({ ctx: b.ctx }).resource).toBe('https://b.xid.dev')
  })
})
