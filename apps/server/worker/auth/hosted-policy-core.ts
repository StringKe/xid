import type { HostedAuthPolicy, TenantContext } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { AppError } from '../lib/errors'

export type HostedAuthPolicyDenialReason =
  | 'force_sso'
  | 'global_login_disabled'
  | 'global_user_creation_disabled'
  | 'method_disabled'
  | 'method_not_configured'
  | 'method_login_disabled'
  | 'method_user_creation_disabled'
  | 'identifier_mode_not_allowed'
  | 'instance_tenant_unresolved'
  | 'invalid_email'
  | 'email_domain_blocked'
  | 'email_domain_not_allowed'
  | 'provider_not_configured'
  | 'provider_login_disabled'
  | 'provider_user_creation_disabled'
  | 'provider_email_unverified'
  | 'provider_email_domain_blocked'
  | 'provider_email_domain_not_allowed'
  | 'enterprise_sso_disabled'
  | 'enterprise_sso_login_disabled'
  | 'enterprise_sso_jit_user_creation_disabled'
  | 'enterprise_sso_email_domain_blocked'
  | 'enterprise_sso_email_domain_not_allowed'
  | 'profile_field_required'

export class HostedAuthPolicyError extends AppError {
  readonly policyReason: HostedAuthPolicyDenialReason
  readonly field?: string

  constructor(
    reason: HostedAuthPolicyDenialReason,
    code: 'invalid_credentials' | 'invalid_request' = 'invalid_credentials',
    options: { field?: string } = {},
  ) {
    super(code)
    this.name = 'HostedAuthPolicyError'
    this.policyReason = reason
    if (options.field) this.field = options.field
  }
}

export function hostedAuthPolicy(tenant: TenantContext): HostedAuthPolicy {
  return tenant.policy?.hostedAuth ?? DEFAULT_HOSTED_AUTH_POLICY
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase()
}

export function emailDomain(email: string): string | null {
  const idx = email.lastIndexOf('@')
  if (idx <= 0 || idx === email.length - 1) return null
  return normalizeDomain(email.slice(idx + 1))
}

export function isHostedAuthPolicyError(value: unknown): value is HostedAuthPolicyError {
  return value instanceof HostedAuthPolicyError
}

export function deny(reason: HostedAuthPolicyDenialReason): never {
  throw new HostedAuthPolicyError(reason)
}

export function denyInvalidRequest(reason: HostedAuthPolicyDenialReason): never {
  throw new HostedAuthPolicyError(reason, 'invalid_request')
}

export function assertEmailAllowed(tenant: TenantContext, email: string | null): void {
  const policy = hostedAuthPolicy(tenant)
  if (!email) return
  const domain = emailDomain(email)
  if (!domain) deny('invalid_email')
  if (policy.blockedEmailDomains.includes(domain)) deny('email_domain_blocked')
  if (policy.allowedEmailDomains.length > 0 && !policy.allowedEmailDomains.includes(domain)) {
    deny('email_domain_not_allowed')
  }
}
