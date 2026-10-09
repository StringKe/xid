// Password-vaulted apps (SWA) of the organizations the user belongs to; served by /sso/swa.

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { useApiMutation, useApiQuery } from '../../lib/queries'

export type SwaApp = {
  id: string
  orgId: string
  organizationName: string
  name: string | null
  targetOrigin: string
  stored: boolean
  username: string | null
}

export type SwaCredentialInput = { connectionId: string; username: string; password: string }

const swaAppsKey = ['me', 'swa-apps'] as const

export function swaLaunchUrl(connectionId: string): string {
  return `/sso/swa/${encodeURIComponent(connectionId)}/launch`
}

export function useSwaAppsQuery(): UseQueryResult<{ data: SwaApp[] }, XidError> {
  return useApiQuery<{ data: SwaApp[] }>(swaAppsKey, '/sso/swa/apps')
}

export function useSaveSwaCredential(): UseMutationResult<unknown, XidError, SwaCredentialInput> {
  return useApiMutation<unknown, SwaCredentialInput>(
    (api, { connectionId, username, password }) =>
      api.post<unknown>(`/sso/swa/${encodeURIComponent(connectionId)}/vault`, {
        username,
        password,
      }),
    { invalidate: [swaAppsKey] },
  )
}

export function useRemoveSwaCredential(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, connectionId) => api.del<unknown>(`/sso/swa/${encodeURIComponent(connectionId)}/vault`),
    { invalidate: [swaAppsKey] },
  )
}
