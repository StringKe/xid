// account portal /v1/me/* 数据层;实体类型契约见 ./types。

import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import { queryKeys, useApiMutation, useApiQuery } from '../../lib/queries'
import type { PasskeyRegistrationOptions, PasskeyRegistrationVerifyBody } from '../sign-in/passkey'
import type {
  ActiveSession,
  AuthorizedApp,
  BackupCodesResponse,
  EmailAddress,
  MfaFactor,
  PasskeyList,
  PasskeySignalData,
  PasswordStatus,
  PhoneList,
  PhoneNumber,
  PrivacyRequest,
  SmsFactorOption,
  SocialConnection,
  TotpSetupResponse,
  UpdateProfilePayload,
  UserProfile,
} from './types'

// conditional:密码登录刚完成时由浏览器静默提议保存 passkey(Conditional Create),不弹窗打断。
export type PasskeyRegistrationRequest = {
  deviceName?: string
  securityKey?: boolean
  mediation?: 'conditional'
  signal?: AbortSignal
}

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

const SMS_FACTOR_OPTION_KEY = [...queryKeys.meMfaFactors, 'sms'] as const

export function useSmsFactorOptionQuery(): UseQueryResult<SmsFactorOption, XidError> {
  return useApiQuery<SmsFactorOption>(SMS_FACTOR_OPTION_KEY, '/v1/me/mfa-factors/sms')
}

export function useEnrollSmsFactor(): UseMutationResult<unknown, XidError, void> {
  return useApiMutation<unknown, void>((api) => api.post<unknown>('/v1/me/mfa-factors/sms'), {
    invalidate: [queryKeys.meMfaFactors, queryKeys.me],
  })
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

export function usePasskeysQuery(): UseQueryResult<PasskeyList, XidError> {
  return useApiQuery<PasskeyList>(queryKeys.mePasskeys, '/v1/me/passkeys')
}

export function useRegisterPasskey(): UseMutationResult<
  unknown,
  XidError,
  PasskeyRegistrationRequest
> {
  return useApiMutation<unknown, PasskeyRegistrationRequest>(
    async (api, { deviceName, securityKey, mediation, signal }) => {
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
      const publicKey = registrationOptionsToPublicKey(options.value)
      // WebAuthn hints:「Use a security key」让浏览器优先提示插入或轻触安全密钥。
      const hinted: PublicKeyCredentialCreationOptions = securityKey
        ? Object.assign({}, publicKey, { hints: ['security-key'] })
        : publicKey
      const credential = await navigator.credentials.create({
        ...(mediation ? { mediation } : {}),
        ...(signal ? { signal } : {}),
        publicKey: hinted,
      } as CredentialCreationOptions)
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

export function usePrivacyRequestsQuery(): UseQueryResult<PrivacyRequest[], XidError> {
  return useApiQuery<PrivacyRequest[]>(queryKeys.mePrivacyRequests, '/v1/me/privacy/requests')
}

export function useCreatePrivacyRequest(): UseMutationResult<
  PrivacyRequest,
  XidError,
  { type: 'export' } | { type: 'delete'; confirmation: 'DELETE' }
> {
  return useApiMutation<
    PrivacyRequest,
    { type: 'export' } | { type: 'delete'; confirmation: 'DELETE' }
  >((api, payload) => api.post<PrivacyRequest>('/v1/me/privacy/requests', payload), {
    invalidate: [queryKeys.mePrivacyRequests],
  })
}

export function useCancelPrivacyRequest(): UseMutationResult<PrivacyRequest, XidError, string> {
  return useApiMutation<PrivacyRequest, string>(
    (api, id) => api.post<PrivacyRequest>(`/v1/me/privacy/requests/${id}/cancel`),
    { invalidate: [queryKeys.mePrivacyRequests] },
  )
}

const accountKeys = {
  emails: ['me', 'emails'] as const,
  phones: ['me', 'phones'] as const,
  password: ['me', 'password'] as const,
  authorizedApps: ['me', 'authorized-apps'] as const,
}

export function usePasswordStatusQuery(): UseQueryResult<PasswordStatus, XidError> {
  return useApiQuery<PasswordStatus>(accountKeys.password, '/v1/me/password')
}

// 没有密码时省略 currentPassword,服务端在 step-up 后直接设置。
export function useSetPassword(): UseMutationResult<
  unknown,
  XidError,
  { currentPassword?: string; newPassword: string }
> {
  return useApiMutation<unknown, { currentPassword?: string; newPassword: string }>(
    (api, payload) => api.post<unknown>('/v1/me/password', payload),
    { invalidate: [accountKeys.password, queryKeys.me] },
  )
}

export function useEmailsQuery(): UseQueryResult<{ data: EmailAddress[] }, XidError> {
  return useApiQuery<{ data: EmailAddress[] }>(accountKeys.emails, '/v1/me/emails')
}

export function useAddEmail(): UseMutationResult<EmailAddress, XidError, string> {
  return useApiMutation<EmailAddress, string>(
    (api, email) => api.post<EmailAddress>('/v1/me/emails', { email }),
    { invalidate: [accountKeys.emails] },
  )
}

export function useSendEmailCode(): UseMutationResult<EmailAddress, XidError, string> {
  return useApiMutation<EmailAddress, string>(
    (api, id) => api.post<EmailAddress>(`/v1/me/emails/${id}/send-code`),
    { invalidate: [accountKeys.emails] },
  )
}

export function useVerifyEmail(): UseMutationResult<
  unknown,
  XidError,
  { id: string; code: string }
> {
  return useApiMutation<unknown, { id: string; code: string }>(
    (api, { id, code }) => api.post<unknown>(`/v1/me/emails/${id}/verify`, { code }),
    { invalidate: [accountKeys.emails, queryKeys.me, queryKeys.meProfile] },
  )
}

export function useMakeEmailPrimary(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, id) => api.post<unknown>(`/v1/me/emails/${id}/primary`),
    { invalidate: [accountKeys.emails, queryKeys.me, queryKeys.meProfile] },
  )
}

export function useRemoveEmail(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>((api, id) => api.del<unknown>(`/v1/me/emails/${id}`), {
    invalidate: [accountKeys.emails],
  })
}

export function usePhonesQuery(): UseQueryResult<PhoneList, XidError> {
  return useApiQuery<PhoneList>(accountKeys.phones, '/v1/me/phones')
}

export function useAddPhone(): UseMutationResult<PhoneNumber, XidError, string> {
  return useApiMutation<PhoneNumber, string>(
    (api, phone) => api.post<PhoneNumber>('/v1/me/phones', { phone }),
    { invalidate: [accountKeys.phones] },
  )
}

export function useVerifyPhone(): UseMutationResult<
  unknown,
  XidError,
  { id: string; code: string }
> {
  return useApiMutation<unknown, { id: string; code: string }>(
    (api, { id, code }) => api.post<unknown>(`/v1/me/phones/${id}/verify`, { code }),
    { invalidate: [accountKeys.phones, queryKeys.meMfaFactors] },
  )
}

export function useRemovePhone(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>((api, id) => api.del<unknown>(`/v1/me/phones/${id}`), {
    invalidate: [accountKeys.phones, queryKeys.meMfaFactors],
  })
}

export function useStartSocialLink(): UseMutationResult<{ url: string }, XidError, string> {
  return useApiMutation<{ url: string }, string>((api, provider) =>
    api.post<{ url: string }>(`/v1/me/social-connections/${encodeURIComponent(provider)}/link`),
  )
}

export function useAuthorizedAppsQuery(): UseQueryResult<AuthorizedApp[], XidError> {
  return useApiQuery<AuthorizedApp[]>(accountKeys.authorizedApps, '/v1/me/authorized-apps')
}

export function useRevokeAuthorizedApp(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, clientId) => api.del<unknown>(`/v1/me/authorized-apps/${encodeURIComponent(clientId)}`),
    { invalidate: [accountKeys.authorizedApps] },
  )
}

export function useLeaveOrganization(): UseMutationResult<unknown, XidError, string> {
  return useApiMutation<unknown, string>(
    (api, orgId) => api.post<unknown>(`/v1/me/organizations/${orgId}/leave`),
    { invalidate: [queryKeys.me] },
  )
}

export function usePasskeySignalData(): UseMutationResult<PasskeySignalData, XidError, void> {
  return useApiMutation<PasskeySignalData, void>((api) =>
    api.get<PasskeySignalData>('/v1/me/passkeys/signal'),
  )
}
