import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { PlatformSettings, PlatformSettingsPatch, XidError } from '@xid-kit/types'
import { queryKeys, useApiMutation, useApiQuery } from '@xid-kit/web-ui/queries'

export type ConfigurationStatus = 'configured' | 'not_configured' | 'misconfigured'

export type InstanceSettings = PlatformSettings & {
  turnstile: { status: ConfigurationStatus; siteKey: string | null }
  emailSending: { provider: 'cloudflare_email_service'; fromAddress: string; fromName: string }
  customDomains: { status: ConfigurationStatus; cnameTarget: string | null }
  billingAdapter: { kind: 'stripe_metered_mau' | 'off'; status: ConfigurationStatus }
  orgsFollowingDefaults: { following: number; total: number }
}

export type SigningKeyStatus = 'next' | 'active' | 'retiring'

export type PlatformSigningKey = {
  kid: string
  alg: string
  status: SigningKeyStatus
  createdAt: number
  activatedAt: number | null
  retireAfter: number | null
  activatableAt: number | null
}

const signingKeysQueryKey = ['platform', 'signing-keys'] as const

export function useInstanceSettingsQuery(): UseQueryResult<InstanceSettings, XidError> {
  return useApiQuery<InstanceSettings>(queryKeys.platformSettings, '/v1/platform/settings')
}

export function useUpdateInstanceSettings(): UseMutationResult<
  InstanceSettings,
  XidError,
  PlatformSettingsPatch
> {
  return useApiMutation<InstanceSettings, PlatformSettingsPatch>(
    (api, body) => api.patch<InstanceSettings>('/v1/platform/settings', body),
    { invalidate: [queryKeys.platformSettings] },
  )
}

export function useSigningKeysQuery(): UseQueryResult<{ data: PlatformSigningKey[] }, XidError> {
  return useApiQuery<{ data: PlatformSigningKey[] }>(
    signingKeysQueryKey,
    '/v1/platform/signing-keys',
  )
}

export function useActivateSigningKey(): UseMutationResult<
  { data: PlatformSigningKey[] },
  XidError,
  { kid: string }
> {
  return useApiMutation<{ data: PlatformSigningKey[] }, { kid: string }>(
    (api, { kid }) =>
      api.post<{ data: PlatformSigningKey[] }>(
        `/v1/platform/signing-keys/${encodeURIComponent(kid)}/activate`,
        {},
      ),
    { invalidate: [signingKeysQueryKey, ['platform', 'stats']] },
  )
}
