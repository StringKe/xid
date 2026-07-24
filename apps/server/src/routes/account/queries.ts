// account portal 数据层(TanStack Query):/v1/me/* 系列读写。
// 替代 ./hooks 的手写 RemoteData/loading 三态;读用 useApiQuery,写用 useApiMutation(成功 invalidate)。
// 实体类型沿用 ./hooks 导出契约;错误为 XidError(页面用 code 走 lingui)。
// 设计真相源:docs/design/05-users-sessions.md

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { queryKeys, useApiMutation, useApiQuery } from '../../lib/queries'
import type { PasskeyRegistrationOptions, PasskeyRegistrationVerifyBody } from '../sign-in/passkey'
import type {
  ActiveSession,
  BackupCodesResponse,
  MfaFactor,
  PasskeyCredential,
  SocialConnection,
  TotpSetupResponse,
  TrustedDevice,
  UpdateProfilePayload,
  UserProfile,
} from './hooks'

export function useProfileQuery(): UseQueryResult<UserProfile, XidError> {
  return useApiQuery<UserProfile>(queryKeys.meProfile, '/v1/me/profile')
}

export function useUpdateProfile(): UseMutationResult<UserProfile, XidError, UpdateProfilePayload> {
  return useApiMutation<UserProfile, UpdateProfilePayload>(
    (api, payload) => api.patch<UserProfile>('/v1/me/profile', payload),
    { invalidate: [queryKeys.meProfile, queryKeys.me] },
  )
}

export function useMfaFactorsQuery(): UseQueryResult<MfaFactor[], XidError> {
  return useApiQuery<MfaFactor[]>(queryKeys.meMfaFactors, '/v1/me/mfa-factors')
}

export function useRemoveMfaFactor(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, id) => api.del<unknown>(`/v1/me/mfa-factors/${id}`),
    { invalidate: [queryKeys.meMfaFactors, queryKeys.me] },
  )
}

export function useStartTotpSetup(): UseMutationResult<TotpSetupResponse, XidError, void> {
  return useApiMutation<TotpSetupResponse, void>(
    (api) => api.post<TotpSetupResponse>('/v1/me/mfa-factors/totp/setup'),
    { invalidate: [queryKeys.meMfaFactors] },
  )
}

export function useVerifyTotpSetup(): UseMutationResult<
  unknown,
  XidError,
  { factorId: string; code: string }
> {
  return useApiMutation<unknown, { factorId: string; code: string }>(
    (api, payload) => api.post<unknown>('/v1/me/mfa-factors/totp/verify', payload),
    { invalidate: [queryKeys.meMfaFactors, queryKeys.me] },
  )
}

export function useGenerateBackupCodes(): UseMutationResult<BackupCodesResponse, XidError, void> {
  return useApiMutation<BackupCodesResponse, void>(
    (api) => api.post<BackupCodesResponse>('/v1/me/mfa-factors/backup-codes'),
    { invalidate: [queryKeys.meMfaFactors, queryKeys.me] },
  )
}

export function usePasskeysQuery(): UseQueryResult<PasskeyCredential[], XidError> {
  return useApiQuery<PasskeyCredential[]>(queryKeys.mePasskeys, '/v1/me/passkeys')
}

export function useRegisterPasskey(): UseMutationResult<
  unknown,
  XidError,
  { deviceName?: string }
> {
  return useApiMutation<unknown, { deviceName?: string }>(
    async (api, { deviceName }) => {
      const options = await api.post<PasskeyRegistrationOptions>('/auth/passkey/register/options')
      if (!options.ok) return options

      const { registrationOptionsToPublicKey, serializeRegistration } =
        await import('../sign-in/passkey')
      if (!('credentials' in navigator) || !('PublicKeyCredential' in globalThis)) {
        return {
          ok: false,
          error: {
            code: 'invalid_credentials',
            message: '',
            httpStatus: 400,
          },
        }
      }
      const credential = await navigator.credentials.create({
        publicKey: registrationOptionsToPublicKey(options.value),
      })
      if (!(credential instanceof PublicKeyCredential)) {
        return {
          ok: false,
          error: {
            code: 'invalid_credentials',
            message: '',
            httpStatus: 400,
          },
        }
      }

      const verifyBody: PasskeyRegistrationVerifyBody = serializeRegistration(
        credential,
        deviceName,
      )
      return api.post<unknown>('/auth/passkey/register/verify', verifyBody)
    },
    { invalidate: [queryKeys.mePasskeys, queryKeys.me] },
  )
}

export function useRenamePasskey(): UseMutationResult<
  unknown,
  XidError,
  { id: string; deviceName: string }
> {
  return useApiMutation<unknown, { id: string; deviceName: string }>(
    (api, { id, deviceName }) => api.patch<unknown>(`/v1/me/passkeys/${id}`, { deviceName }),
    { invalidate: [queryKeys.mePasskeys] },
  )
}

export function useRemovePasskey(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>((api, id) => api.del<unknown>(`/v1/me/passkeys/${id}`), {
    invalidate: [queryKeys.mePasskeys],
  })
}

export function useSocialConnectionsQuery(): UseQueryResult<SocialConnection[], XidError> {
  return useApiQuery<SocialConnection[]>(queryKeys.meSocialConnections, '/v1/me/social-connections')
}

export function useDisconnectSocial(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, id) => api.del<unknown>(`/v1/me/social-connections/${id}`),
    { invalidate: [queryKeys.meSocialConnections] },
  )
}

export function useSessionsQuery(): UseQueryResult<ActiveSession[], XidError> {
  return useApiQuery<ActiveSession[]>(queryKeys.meSessions, '/v1/me/sessions')
}

export function useRevokeSession(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>((api, id) => api.del<unknown>(`/v1/me/sessions/${id}`), {
    invalidate: [queryKeys.meSessions],
  })
}

export function useRevokeAllSessions(): UseMutationResult<unknown, XidError, void> {
  return useApiMutation<unknown, void>((api) => api.post<unknown>('/v1/me/sessions/revoke-all'), {
    invalidate: [queryKeys.meSessions],
  })
}

export function useTrustedDevicesQuery(): UseQueryResult<TrustedDevice[], XidError> {
  return useApiQuery<TrustedDevice[]>(queryKeys.meTrustedDevices, '/v1/me/trusted-devices')
}

export function useRevokeTrustedDevice(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, id) => api.del<unknown>(`/v1/me/trusted-devices/${id}`),
    { invalidate: [queryKeys.meTrustedDevices] },
  )
}

export function useChangePassword(): UseMutationResult<
  unknown,
  XidError,
  { currentPassword: string; newPassword: string }
> {
  return useApiMutation<unknown, { currentPassword: string; newPassword: string }>((api, payload) =>
    api.post<unknown>('/v1/me/password', payload),
  )
}
