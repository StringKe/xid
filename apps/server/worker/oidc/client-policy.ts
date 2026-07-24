// OAuth client security profile helpers (FAPI 2.0 / Browser-Based Apps).

import type { ClientRow } from './shared'
import type { TokenContext } from './token-issue'

type ClientPolicyConfig = {
  fapiProfile?: boolean
  bbaProfile?: boolean
  tlsClientAuthSubjectDn?: string
  mtlsBoundTokens?: boolean
}

export function clientPolicyConfig(client: ClientRow): ClientPolicyConfig {
  const raw = client.customClaimsConfig
  if (!raw || typeof raw !== 'object') return {}
  return raw as ClientPolicyConfig
}

export function clientRequiresFapi(client: ClientRow): boolean {
  return clientPolicyConfig(client).fapiProfile === true
}

export function clientRequiresBba(client: ClientRow): boolean {
  return clientPolicyConfig(client).bbaProfile === true
}

export function clientAllowsMtlsTokenBinding(client: ClientRow): boolean {
  const method = client.tokenEndpointAuthMethod
  if (method === 'tls_client_auth' || method === 'self_signed_tls_client_auth') return true
  return clientPolicyConfig(client).mtlsBoundTokens === true
}

export function hasSenderConstraint(input: {
  dpopJkt: string | null
  mtlsCertThumbprint: string | null
}): boolean {
  return input.dpopJkt !== null || input.mtlsCertThumbprint !== null
}

export function fapiRequiresSenderConstraint(tc: TokenContext): boolean {
  return clientRequiresFapi(tc.client) && !hasSenderConstraint(tc)
}
