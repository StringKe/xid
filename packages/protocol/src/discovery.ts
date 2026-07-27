// Discovery 元数据(03 章 1、9):/.well-known/openid-configuration 与 oauth-authorization-server
// 合并输出,避免两份元数据不一致。issuer 多租户隔离,全字段从 TenantContext 派生。

import { SIGNING_ALGS } from '@xid-kit/types'
import type { SigningAlg, TenantContext } from '@xid-kit/types'
import { ALLOWED_DPOP_ALGS } from './dpop'

// 本实现支持的算法/方法集合(对齐 03 章 endpoint 表 + grant 表)。
const RESPONSE_TYPES = ['code', 'code id_token'] as const
const RESPONSE_MODES = ['query', 'fragment', 'form_post', 'query.jwt', 'fragment.jwt'] as const
const GRANT_TYPES = [
  'authorization_code',
  'client_credentials',
  'refresh_token',
  'urn:ietf:params:oauth:grant-type:device_code',
  'urn:ietf:params:oauth:grant-type:token-exchange',
  'urn:openid:params:grant-type:ciba',
] as const
const SUBJECT_TYPES = ['public'] as const
// address 无用户数据模型支撑不声明;organization 有真实语义(authorize 组织选择分流)。
const SCOPES = ['openid', 'profile', 'email', 'phone', 'offline_access', 'organization'] as const
const TOKEN_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'private_key_jwt',
  'tls_client_auth',
  'self_signed_tls_client_auth',
  'none',
] as const

const CODE_CHALLENGE_METHODS = ['S256'] as const // 拒 plain(oidc-oauth rule)
const AUTHORIZATION_DETAILS_TYPES = ['resource_access'] as const
// claims_supported = userinfo/ID token 实出集合:profile/phone 投影见 userinfo.ts。
// sid 随 authorization_codes/refresh_tokens.session_id 写入 ID token(仅 hosted session 链路,见 03 章 9.1)。
const CLAIMS = [
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'auth_time',
  'nonce',
  'acr',
  'amr',
  'sid',
  'azp',
  'at_hash',
  'c_hash',
  'email',
  'email_verified',
  'name',
  'given_name',
  'family_name',
  'preferred_username',
  'picture',
  'locale',
  'zoneinfo',
  'phone_number',
  'phone_number_verified',
] as const
const RESOURCE_DOCUMENTATION_URL = 'https://xid.dev/oidc-oauth'

export type DiscoveryMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
  registration_endpoint: string
  introspection_endpoint: string
  revocation_endpoint: string
  end_session_endpoint: string
  device_authorization_endpoint: string
  pushed_authorization_request_endpoint: string
  require_pushed_authorization_requests: boolean
  response_types_supported: readonly string[]
  response_modes_supported: readonly string[]
  grant_types_supported: readonly string[]
  subject_types_supported: readonly string[]
  scopes_supported: readonly string[]
  token_endpoint_auth_methods_supported: readonly string[]
  tls_client_certificate_bound_access_tokens: boolean
  id_token_signing_alg_values_supported: readonly SigningAlg[]
  code_challenge_methods_supported: readonly string[]
  claims_supported: readonly string[]
  dpop_signing_alg_values_supported: readonly SigningAlg[]
  request_parameter_supported: boolean
  request_uri_parameter_supported: boolean
  request_object_signing_alg_values_supported: readonly SigningAlg[]
  authorization_details_types_supported: readonly string[]
  frontchannel_logout_supported: boolean
  frontchannel_logout_session_supported: boolean
  backchannel_logout_supported: boolean
  backchannel_logout_session_supported: boolean
  check_session_iframe: string | null
  backchannel_authentication_endpoint: string | null
  backchannel_token_delivery_modes_supported?: readonly string[]
  federation_registration_endpoint: string | null
  authorization_response_iss_parameter_supported: boolean
  browser_based_apps_profile_supported?: boolean
  fapi_profile_supported?: boolean
}

export type ProtectedResourceMetadata = {
  resource: string
  authorization_servers: readonly string[]
  jwks_uri: string
  bearer_methods_supported: readonly string[]
  dpop_signing_alg_values_supported: readonly SigningAlg[]
  resource_documentation: string
}

// 从 TenantContext 派生 issuer + 端点 + 支持的算法集(签名算法取自 active 密钥集)。
export function buildDiscoveryMetadata(input: {
  ctx: TenantContext
  requirePar?: boolean
  mtlsSupported?: boolean
  fapiProfileSupported?: boolean
  browserBasedAppsProfileSupported?: boolean
}): DiscoveryMetadata {
  const issuer = input.ctx.issuer
  const at = (path: string): string => `${issuer}${path}`
  const algs = signingAlgsOf(input.ctx)
  return {
    issuer,
    authorization_endpoint: at('/authorize'),
    token_endpoint: at('/token'),
    userinfo_endpoint: at('/userinfo'),
    jwks_uri: at('/jwks'),
    registration_endpoint: at('/register'),
    introspection_endpoint: at('/introspect'),
    revocation_endpoint: at('/revoke'),
    end_session_endpoint: at('/end_session'),
    device_authorization_endpoint: at('/device_authorization'),
    pushed_authorization_request_endpoint: at('/par'),
    require_pushed_authorization_requests: input.requirePar ?? false,
    response_types_supported: RESPONSE_TYPES,
    response_modes_supported: RESPONSE_MODES,
    grant_types_supported: GRANT_TYPES,
    subject_types_supported: SUBJECT_TYPES,
    scopes_supported: SCOPES,
    token_endpoint_auth_methods_supported:
      input.mtlsSupported === false
        ? TOKEN_AUTH_METHODS.filter(
            (m) => m !== 'tls_client_auth' && m !== 'self_signed_tls_client_auth',
          )
        : TOKEN_AUTH_METHODS,
    tls_client_certificate_bound_access_tokens: input.mtlsSupported !== false,
    id_token_signing_alg_values_supported: algs,
    code_challenge_methods_supported: CODE_CHALLENGE_METHODS,
    claims_supported: CLAIMS,
    // DPoP proof 验签白名单(dpop.ts),与服务器签名密钥集无关。
    dpop_signing_alg_values_supported: ALLOWED_DPOP_ALGS,
    request_parameter_supported: true,
    request_uri_parameter_supported: true,
    // request object 按 client 注册 JWKS 的 jwk.alg 验签(request-object.ts),接受 SigningAlg 全集。
    request_object_signing_alg_values_supported: SIGNING_ALGS,
    authorization_details_types_supported: AUTHORIZATION_DETAILS_TYPES,
    frontchannel_logout_supported: true,
    frontchannel_logout_session_supported: true,
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
    check_session_iframe: at('/check_session'),
    backchannel_authentication_endpoint: at('/backchannel_authentication'),
    backchannel_token_delivery_modes_supported: ['poll'],
    federation_registration_endpoint: at('/federation_registration'),
    // RFC9207:成功与错误回跳均带 iss 参数(authorize.ts)。
    authorization_response_iss_parameter_supported: true,
    browser_based_apps_profile_supported: input.browserBasedAppsProfileSupported === true,
    fapi_profile_supported: input.fapiProfileSupported === true,
  }
}

// RFC9728 protected resource metadata for XID-hosted OAuth resource endpoints.
export function buildProtectedResourceMetadata(input: {
  ctx: TenantContext
}): ProtectedResourceMetadata {
  const issuer = input.ctx.issuer
  return {
    resource: issuer,
    authorization_servers: [issuer],
    jwks_uri: `${issuer}/jwks`,
    bearer_methods_supported: ['header'],
    dpop_signing_alg_values_supported: ALLOWED_DPOP_ALGS,
    resource_documentation: RESOURCE_DOCUMENTATION_URL,
  }
}

// active 密钥集里出现过的算法去重(默认 alg 排首)。
function signingAlgsOf(ctx: TenantContext): readonly SigningAlg[] {
  const seen = new Set<SigningAlg>([ctx.signingKeys.defaultAlg])
  for (const k of ctx.signingKeys.keys) seen.add(k.alg)
  return [...seen]
}
