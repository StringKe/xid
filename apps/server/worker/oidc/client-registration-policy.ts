import { normalizePublicJwks } from '@xid-kit/protocol'

export const VALID_CLIENT_TYPES = ['public', 'confidential'] as const
export const VALID_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'private_key_jwt',
  'tls_client_auth',
  'self_signed_tls_client_auth',
  'none',
] as const
export const VALID_GRANT_TYPES = [
  'authorization_code',
  'refresh_token',
  'client_credentials',
  'urn:ietf:params:oauth:grant-type:device_code',
  'urn:ietf:params:oauth:grant-type:token-exchange',
  'urn:openid:params:grant-type:ciba',
] as const
export const VALID_RESPONSE_TYPES = ['code', 'code id_token'] as const

export type ClientType = (typeof VALID_CLIENT_TYPES)[number]
export type ClientAuthMethod = (typeof VALID_AUTH_METHODS)[number]
export type ClientGrantType = (typeof VALID_GRANT_TYPES)[number]
export type ClientResponseType = (typeof VALID_RESPONSE_TYPES)[number]

export type ClientPolicyViolation = {
  field:
    | 'client_type'
    | 'token_endpoint_auth_method'
    | 'allowed_grant_types'
    | 'allowed_response_types'
    | 'allowed_scopes'
    | 'require_pkce'
    | 'dpop_bound_access_tokens'
    | 'client_secret'
    | 'jwks'
    | 'tls_client_auth_subject_dn'
    | 'tls_client_auth_cert_thumbprints'
  message: string
}

export type ClientRegistrationPolicy = {
  clientType: string
  authMethod: string
  grantTypes: readonly string[]
  responseTypes: readonly string[]
  scopes: readonly string[]
  requirePkce: boolean
  dpopBoundAccessTokens: boolean
  hasClientSecret: boolean
  jwks: unknown
  tlsClientAuthSubjectDn?: string
  tlsClientAuthCertThumbprints: readonly string[]
}

function unsupportedValue(
  field: ClientPolicyViolation['field'],
  values: readonly string[],
  allowed: readonly string[],
): ClientPolicyViolation | null {
  if (values.length !== new Set(values).size) {
    return { field, message: `${field} must not contain duplicates` }
  }
  const unsupported = values.find((value) => !allowed.includes(value))
  return unsupported
    ? { field, message: `${field} contains unsupported value ${unsupported}` }
    : null
}

export function sharedSecretAuthMethod(method: string): boolean {
  return method === 'client_secret_basic' || method === 'client_secret_post'
}

export function validatePublicGrantPolicy(input: {
  authMethod: string
  grantTypes: readonly string[]
  dpopBoundAccessTokens: boolean
}): ClientPolicyViolation | null {
  if (input.authMethod !== 'none') return null
  const confidentialOnly = input.grantTypes.find(
    (grant) =>
      grant === 'client_credentials' ||
      grant === 'urn:ietf:params:oauth:grant-type:token-exchange' ||
      grant === 'urn:openid:params:grant-type:ciba',
  )
  if (confidentialOnly) {
    return {
      field: 'allowed_grant_types',
      message: `public clients cannot use ${confidentialOnly}`,
    }
  }
  if (input.grantTypes.includes('refresh_token') && !input.dpopBoundAccessTokens) {
    return {
      field: 'dpop_bound_access_tokens',
      message: 'public clients with refresh_token require dpop_bound_access_tokens=true',
    }
  }
  return null
}

export function validateClientRegistrationPolicy(
  input: ClientRegistrationPolicy,
): ClientPolicyViolation | null {
  if (!VALID_CLIENT_TYPES.includes(input.clientType as ClientType)) {
    return { field: 'client_type', message: `unsupported client_type ${input.clientType}` }
  }
  if (!VALID_AUTH_METHODS.includes(input.authMethod as ClientAuthMethod)) {
    return {
      field: 'token_endpoint_auth_method',
      message: `unsupported token_endpoint_auth_method ${input.authMethod}`,
    }
  }
  const grantError = unsupportedValue('allowed_grant_types', input.grantTypes, VALID_GRANT_TYPES)
  if (grantError) return grantError
  const responseError = unsupportedValue(
    'allowed_response_types',
    input.responseTypes,
    VALID_RESPONSE_TYPES,
  )
  if (responseError) return responseError
  if (input.scopes.length !== new Set(input.scopes).size || input.scopes.some((scope) => !scope)) {
    return {
      field: 'allowed_scopes',
      message: 'allowed_scopes must contain unique non-empty values',
    }
  }

  const isPublic = input.clientType === 'public'
  if (isPublic !== (input.authMethod === 'none')) {
    return {
      field: 'token_endpoint_auth_method',
      message: isPublic
        ? 'public clients must use token_endpoint_auth_method=none'
        : 'confidential clients must use an authenticated token endpoint method',
    }
  }
  if (isPublic && !input.requirePkce) {
    return { field: 'require_pkce', message: 'public clients must require PKCE' }
  }
  if (isPublic && input.hasClientSecret) {
    return { field: 'client_secret', message: 'public clients must not have a client secret' }
  }
  if (sharedSecretAuthMethod(input.authMethod) && !input.hasClientSecret) {
    return {
      field: 'client_secret',
      message: `${input.authMethod} requires a stored client secret`,
    }
  }
  if (!sharedSecretAuthMethod(input.authMethod) && input.hasClientSecret) {
    return {
      field: 'client_secret',
      message: `${input.authMethod} must not retain a shared client secret`,
    }
  }
  if (input.authMethod === 'private_key_jwt' && !normalizePublicJwks(input.jwks).ok) {
    return { field: 'jwks', message: 'private_key_jwt requires a valid public jwks' }
  }
  if (
    (input.authMethod === 'tls_client_auth' ||
      input.authMethod === 'self_signed_tls_client_auth') &&
    !input.tlsClientAuthSubjectDn?.trim()
  ) {
    return {
      field: 'tls_client_auth_subject_dn',
      message: `${input.authMethod} requires tls_client_auth_subject_dn`,
    }
  }
  if (
    input.authMethod === 'self_signed_tls_client_auth' &&
    input.tlsClientAuthCertThumbprints.length === 0
  ) {
    return {
      field: 'tls_client_auth_cert_thumbprints',
      message: 'self_signed_tls_client_auth requires a certificate thumbprint',
    }
  }
  return validatePublicGrantPolicy(input)
}

export function storedClientPolicy(row: {
  clientType: string
  tokenEndpointAuthMethod: string
  allowedGrantTypes: readonly string[]
  allowedResponseTypes: readonly string[]
  allowedScopes: readonly string[]
  requirePkce: boolean
  dpopBoundAccessTokens: boolean
  clientSecretHash: string | null
  jwks: unknown
  customClaimsConfig: unknown
}): ClientRegistrationPolicy {
  const custom =
    row.customClaimsConfig && typeof row.customClaimsConfig === 'object'
      ? (row.customClaimsConfig as Record<string, unknown>)
      : {}
  const thumbprints = Array.isArray(custom['tlsClientAuthCertThumbprints'])
    ? custom['tlsClientAuthCertThumbprints'].filter(
        (value): value is string => typeof value === 'string',
      )
    : []
  return {
    clientType: row.clientType,
    authMethod: row.tokenEndpointAuthMethod,
    grantTypes: Array.isArray(row.allowedGrantTypes) ? row.allowedGrantTypes : [],
    responseTypes: Array.isArray(row.allowedResponseTypes) ? row.allowedResponseTypes : ['code'],
    scopes: Array.isArray(row.allowedScopes) ? row.allowedScopes : [],
    requirePkce: row.requirePkce === true,
    dpopBoundAccessTokens: row.dpopBoundAccessTokens === true,
    hasClientSecret: row.clientSecretHash !== null,
    jwks: row.jwks,
    tlsClientAuthSubjectDn:
      typeof custom['tlsClientAuthSubjectDn'] === 'string'
        ? custom['tlsClientAuthSubjectDn']
        : undefined,
    tlsClientAuthCertThumbprints: thumbprints,
  }
}
