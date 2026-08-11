import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../lib/api'

export type RemoteData<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: T }

export type UserProfile = {
  id: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  email: string
  emailVerified: boolean
  imageUrl: string | null
  locale: string | null
  timezone: string | null
}

export type UpdateProfilePayload = {
  firstName?: string | null
  lastName?: string | null
  displayName?: string | null
  locale?: string | null
  timezone?: string | null
}

export type TotpFactor = {
  id: string
  type: 'totp'
  createdAt: string
}

export type BackupCodeFactor = {
  id: string
  type: 'backup_codes'
  remaining: number
  createdAt: string
}

export type SmsFactor = {
  id: string
  type: 'sms'
  createdAt: string
}

export type PasskeyFactor = {
  id: string
  type: 'passkey'
  deviceName: string | null
  createdAt: string
}

export type MfaFactor = TotpFactor | BackupCodeFactor | SmsFactor | PasskeyFactor

export type TotpSetupResponse = {
  factorId: string
  secret: string
  otpauthUri: string
}

export type BackupCodesResponse = {
  batchId: string
  codes: string[]
}

export type PasskeyCredential = {
  id: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
  transports: readonly string[]
}

export type SocialConnection = {
  id: string
  provider: string
  providerAccountId: string
  email: string | null
  connectedAt: string
}

export type ActiveSession = {
  id: string
  deviceName: string | null
  deviceFingerprint: string | null
  ipAddress: string | null
  lastActiveAt: string
  expiresAt: string
  isCurrent: boolean
}

export type TrustedDevice = {
  id: string
  deviceName: string | null
  fingerprint: string
  trustedAt: string
  lastSeenAt: string
}

export type PrivacyRequest = {
  id: string
  type: 'export' | 'delete'
  status: 'pending' | 'processing' | 'completed' | 'canceled' | 'expired'
  availableAt: string | null
  expiresAt: string | null
  scheduledFor: string | null
  completedAt: string | null
  canceledAt: string | null
  errorCode: string | null
  downloadUrl: string | null
  createdAt: string
  updatedAt: string
}

function useRemoteList<T>(api: ApiClient, path: string): [RemoteData<T[]>, () => void] {
  const [state, setState] = useState<RemoteData<T[]>>({ status: 'loading' })
  const pathRef = useRef(path)
  pathRef.current = path

  const load = useCallback(() => {
    setState({ status: 'loading' })
    void (async () => {
      const result = await api.get<T[]>(pathRef.current)
      if (result.ok) {
        setState({ status: 'ok', data: result.value })
      } else {
        setState({ status: 'error', message: result.error.longMessage ?? result.error.message })
      }
    })()
  }, [api])

  useEffect(() => {
    load()
  }, [load])

  return [state, load]
}

export type UseProfileResult = {
  profile: RemoteData<UserProfile>
  update: (payload: UpdateProfilePayload) => Promise<string | null>
  reload: () => void
}

export function useProfile(api: ApiClient): UseProfileResult {
  const [profile, setProfile] = useState<RemoteData<UserProfile>>({ status: 'loading' })

  const reload = useCallback(() => {
    setProfile({ status: 'loading' })
    void (async () => {
      const result = await api.get<UserProfile>('/v1/me/profile')
      if (result.ok) {
        setProfile({ status: 'ok', data: result.value })
      } else {
        setProfile({ status: 'error', message: result.error.longMessage ?? result.error.message })
      }
    })()
  }, [api])

  useEffect(() => {
    reload()
  }, [reload])

  const update = useCallback(
    async (payload: UpdateProfilePayload): Promise<string | null> => {
      const result = await api.patch<UserProfile>('/v1/me/profile', payload)
      if (result.ok) {
        setProfile({ status: 'ok', data: result.value })
        return null
      }
      return result.error.longMessage ?? result.error.message
    },
    [api],
  )

  return { profile, update, reload }
}

export type UseMfaFactorsResult = {
  factors: RemoteData<MfaFactor[]>
  remove: (id: string) => Promise<string | null>
  reload: () => void
}

export function useMfaFactors(api: ApiClient): UseMfaFactorsResult {
  const [factors, reload] = useRemoteList<MfaFactor>(api, '/v1/me/mfa-factors')

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      const result = await api.del<unknown>(`/v1/me/mfa-factors/${id}`)
      if (result.ok) {
        reload()
        return null
      }
      return result.error.longMessage ?? result.error.message
    },
    [api, reload],
  )

  return { factors, remove, reload }
}

export type UsePasskeysResult = {
  passkeys: RemoteData<PasskeyCredential[]>
  rename: (id: string, deviceName: string) => Promise<string | null>
  remove: (id: string) => Promise<string | null>
  reload: () => void
}

export function usePasskeys(api: ApiClient): UsePasskeysResult {
  const [passkeys, reload] = useRemoteList<PasskeyCredential>(api, '/v1/me/passkeys')

  const rename = useCallback(
    async (id: string, deviceName: string): Promise<string | null> => {
      const result = await api.patch<unknown>(`/v1/me/passkeys/${id}`, { deviceName })
      if (result.ok) {
        reload()
        return null
      }
      return result.error.longMessage ?? result.error.message
    },
    [api, reload],
  )

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      const result = await api.del<unknown>(`/v1/me/passkeys/${id}`)
      if (result.ok) {
        reload()
        return null
      }
      return result.error.longMessage ?? result.error.message
    },
    [api, reload],
  )

  return { passkeys, rename, remove, reload }
}

export type UseSocialConnectionsResult = {
  connections: RemoteData<SocialConnection[]>
  disconnect: (id: string) => Promise<string | null>
  reload: () => void
}

export function useSocialConnections(api: ApiClient): UseSocialConnectionsResult {
  const [connections, reload] = useRemoteList<SocialConnection>(api, '/v1/me/social-connections')

  const disconnect = useCallback(
    async (id: string): Promise<string | null> => {
      const result = await api.del<unknown>(`/v1/me/social-connections/${id}`)
      if (result.ok) {
        reload()
        return null
      }
      return result.error.longMessage ?? result.error.message
    },
    [api, reload],
  )

  return { connections, disconnect, reload }
}

export type UseSessionsResult = {
  sessions: RemoteData<ActiveSession[]>
  revoke: (id: string) => Promise<string | null>
  revokeAll: () => Promise<string | null>
  reload: () => void
}

export function useSessions(api: ApiClient): UseSessionsResult {
  const [sessions, reload] = useRemoteList<ActiveSession>(api, '/v1/me/sessions')

  const revoke = useCallback(
    async (id: string): Promise<string | null> => {
      const result = await api.del<unknown>(`/v1/me/sessions/${id}`)
      if (result.ok) {
        reload()
        return null
      }
      return result.error.longMessage ?? result.error.message
    },
    [api, reload],
  )

  const revokeAll = useCallback(async (): Promise<string | null> => {
    const result = await api.post<unknown>('/v1/me/sessions/revoke-all')
    if (result.ok) {
      reload()
      return null
    }
    return result.error.longMessage ?? result.error.message
  }, [api, reload])

  return { sessions, revoke, revokeAll, reload }
}

export type UseTrustedDevicesResult = {
  devices: RemoteData<TrustedDevice[]>
  revoke: (id: string) => Promise<string | null>
  reload: () => void
}

export function useTrustedDevices(api: ApiClient): UseTrustedDevicesResult {
  const [devices, reload] = useRemoteList<TrustedDevice>(api, '/v1/me/trusted-devices')

  const revoke = useCallback(
    async (id: string): Promise<string | null> => {
      const result = await api.del<unknown>(`/v1/me/trusted-devices/${id}`)
      if (result.ok) {
        reload()
        return null
      }
      return result.error.longMessage ?? result.error.message
    },
    [api, reload],
  )

  return { devices, revoke, reload }
}
