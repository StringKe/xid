// password 登录/注册共用:identifier 解析、注册验证邮件、登录完成(MFA 门控 + 签发 session)。

import { defaultLandingPathFor, normalizePhoneNumber } from '@xid-kit/types'
import type { Context } from 'hono'
import type { HostedAuthFlowResolution } from '../../shared/hosted-auth-continuation'
import { PASSWORD_AUTH_CONTEXT } from '../lib/auth-context'
import { postAuthRedirectPath, resolvePostAuthMfaGate } from '../lib/mfa-session'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession } from '../lib/session'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import type { ProfileFieldInput } from '../auth/profile-fields'
import { issueEmailVerification } from './email-verify-token'
import { requestIp, requestUserAgent } from './shared'

export type PasswordFlow = Pick<
  HostedAuthFlowResolution,
  'intent' | 'continuePath' | 'applicationClientId'
>
export type PasswordAuthResponse =
  | { nextStep: 'verify_email' }
  | { nextStep: 'complete'; redirectUrl: string }
export type IdentifierKind = 'email' | 'username' | 'phone' | 'external_id'
export type ParsedIdentifier = { kind: IdentifierKind; value: string }

// Password 创建默认要求 email verification。username/phone/external_id 创建必须在策略里关闭 email verification。
const REQUIRE_EMAIL_VERIFICATION = true

export function auditIdentifier(identifier: ParsedIdentifier): {
  type: IdentifierKind
  value: string
} {
  return { type: identifier.kind, value: identifier.value }
}

export function parseIdentifier(tenant: TenantVar, rawIdentifier: string): ParsedIdentifier {
  const mode = tenant.policy?.hostedAuth?.identifierMode ?? 'email'
  const trimmed = rawIdentifier.trim()
  const lower = trimmed.toLowerCase()
  if (mode === 'email') return { kind: 'email', value: lower }
  if (mode === 'username') return { kind: 'username', value: lower }
  if (mode === 'phone') return { kind: 'phone', value: normalizePhoneNumber(trimmed) ?? '' }
  if (mode === 'external_id') return { kind: 'external_id', value: trimmed }
  return lower.includes('@') ? { kind: 'email', value: lower } : { kind: 'username', value: lower }
}

export function identifierProfile(identifier: ParsedIdentifier): ProfileFieldInput {
  if (identifier.kind === 'email') return { email: identifier.value }
  if (identifier.kind === 'username') return { username: identifier.value }
  if (identifier.kind === 'phone') return { phone: identifier.value }
  return {}
}

export function passwordRequiresEmailVerification(tenant: TenantVar): boolean {
  const hostedPolicy = tenant.policy?.hostedAuth
  return (
    hostedPolicy?.password?.requireEmailVerification ??
    hostedPolicy?.requireVerifiedEmail ??
    REQUIRE_EMAIL_VERIFICATION
  )
}

export async function sendPasswordVerifyEmail(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { userId: string; email: string; flow: PasswordFlow },
): Promise<PasswordAuthResponse> {
  await issueEmailVerification({
    env: c.env,
    tenant,
    userId: input.userId,
    email: input.email,
    locale: c.get('locale'),
    ...(input.flow.intent ? { intent: input.flow.intent } : {}),
    continuePath: input.flow.continuePath,
    ...(input.flow.applicationClientId
      ? { applicationClientId: input.flow.applicationClientId }
      : {}),
  })
  return { nextStep: 'verify_email' }
}

export async function completePasswordAuth(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  input: { userId: string; rememberMe: boolean; flow: PasswordFlow },
): Promise<PasswordAuthResponse> {
  const returnPath = postAuthRedirectPath({
    intent: input.flow.intent,
    continueParam: input.flow.continuePath,
    fallback: defaultLandingPathFor(tenant),
  })
  const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
    userId: input.userId,
    returnPath,
    sessionAmr: PASSWORD_AUTH_CONTEXT.amr,
  })
  await issueSession(c, {
    sessionId: createPersistedId('session'),
    userId: input.userId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: PASSWORD_AUTH_CONTEXT,
    authenticatedAt: new Date(),
    rememberMe: input.rememberMe,
    ip: requestIp(c),
    userAgent: requestUserAgent(c),
  })
  return { nextStep: 'complete', redirectUrl: mfaGate.redirectUrl ?? returnPath }
}
