// 企业 SSO 的 Home Realm Discovery:只对已验证域名命中,命中后展示过渡屏再整页跳转到 IdP。

import { useMutation } from '@tanstack/react-query'
import type { Result } from '@xid-kit/types'
import type { ApiClient } from '../../lib/api'

export type HrdResponse = {
  organizationId?: string
  connectionId: string | null
  orgId?: string
  protocol?: 'saml' | 'oidc'
  displayName?: string | null
  organizationName?: string | null
}

export type SsoTarget = {
  connectionName: string | null
  protocol: 'saml' | 'oidc'
  organizationName: string | null
  domain: string
  url: string
}

export type SsoRedirectInput = {
  origin: string
  hostedReturn: string
  intent?: string
  clientId?: string
}

export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : ''
}

export function ssoTargetFrom(
  response: HrdResponse,
  input: SsoRedirectInput & { email: string },
): SsoTarget | null {
  if (!response.connectionId || !response.protocol) return null
  const path =
    response.protocol === 'saml'
      ? `/sso/saml/${response.connectionId}/login`
      : `/sso/oidc/${response.connectionId}/authorize`
  const url = new URL(path, input.origin)
  url.searchParams.set('continue', input.hostedReturn)
  if (input.intent) url.searchParams.set('intent', input.intent)
  if (input.clientId) url.searchParams.set('client_id', input.clientId)
  if (response.organizationId) url.searchParams.set('organization_id', response.organizationId)
  return {
    connectionName: response.displayName?.trim() || null,
    protocol: response.protocol,
    organizationName: response.organizationName ?? null,
    domain: emailDomainOf(input.email),
    url: url.toString(),
  }
}

export type DiscoveryRequest = {
  email: string
  organizationId: string | null
  intent?: string
  clientId?: string
  turnstileToken: string | null
}

export function useSsoDiscovery(api: ApiClient, onSettled: () => void) {
  return useMutation({
    mutationFn: (request: DiscoveryRequest): Promise<Result<HrdResponse>> =>
      api.post<HrdResponse>('/sso/hrd', {
        email: request.email,
        ...(request.organizationId ? { organizationId: request.organizationId } : {}),
        ...(request.intent ? { intent: request.intent } : {}),
        ...(request.clientId ? { clientId: request.clientId } : {}),
        turnstileToken: request.turnstileToken,
      }),
    onSettled,
  })
}
