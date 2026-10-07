// 各凭证请求:密码、邮件链接、验证码发送与校验、访客。成功与失败交回调用方决定界面去向。

import { useMutation } from '@tanstack/react-query'
import type { Result } from '@xid-kit/types'
import type { ApiClient } from '../../lib/api'
import { profilePayload, type OtpSignInMethod, type ProfileValues } from './shared'
import { otpEndpoint, otpTarget } from './sign-in-requests'

export type AuthResponse = { redirectUrl?: string; nextStep?: 'verify_email' | 'complete' }

type CredentialInput = {
  api: ApiClient
  flowPayload: (options: { withTurnstile: boolean }) => Record<string, unknown>
  onTurnstileConsumed: () => void
}

export type PasswordRequest = {
  identifier: string
  password: string
  rememberMe: boolean
  profile: ProfileValues | null
}

export type OtpSendRequest = {
  method: OtpSignInMethod
  target: string
  profile: ProfileValues | null
}
export type OtpVerifyRequest = { method: OtpSignInMethod; target: string; code: string }

export function useCredentialMutations({ api, flowPayload, onTurnstileConsumed }: CredentialInput) {
  const password = useMutation({
    mutationFn: (request: PasswordRequest): Promise<Result<AuthResponse>> =>
      api.post<AuthResponse>('/auth/password/sign-in', {
        identifier: request.identifier,
        ...(request.profile ? profilePayload(request.profile) : {}),
        password: request.password,
        rememberMe: request.rememberMe,
        ...flowPayload({ withTurnstile: true }),
      }),
    onSettled: onTurnstileConsumed,
  })

  const magicLink = useMutation({
    mutationFn: (request: { email: string; profile: ProfileValues | null }) =>
      api.post<unknown>('/auth/magic-link/send', {
        email: request.email,
        ...(request.profile ? profilePayload(request.profile) : {}),
        ...flowPayload({ withTurnstile: true }),
      }),
    onSettled: onTurnstileConsumed,
  })

  const otpSend = useMutation({
    mutationFn: (request: OtpSendRequest) =>
      api.post<unknown>(otpEndpoint(request.method, 'send'), {
        [otpTarget(request.method).field]: request.target,
        ...(request.profile ? profilePayload(request.profile) : {}),
        ...flowPayload({ withTurnstile: true }),
      }),
    onSettled: onTurnstileConsumed,
  })

  const otpVerify = useMutation({
    mutationFn: (request: OtpVerifyRequest): Promise<Result<AuthResponse>> =>
      api.post<AuthResponse>(otpEndpoint(request.method, 'verify'), {
        [otpTarget(request.method).field]: request.target,
        code: request.code,
        ...flowPayload({ withTurnstile: false }),
      }),
  })

  const guest = useMutation({
    mutationFn: (input: { capabilityToken: string; turnstileToken: string | null }) =>
      api.post<{ redirectUrl: string }>('/auth/guest', input),
    onSettled: onTurnstileConsumed,
  })

  return { password, magicLink, otpSend, otpVerify, guest }
}
