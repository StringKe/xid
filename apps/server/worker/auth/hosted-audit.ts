import { sha256Hex } from '@xid-kit/crypto'
import type { Context } from 'hono'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { emailDomain, isHostedAuthPolicyError } from './hosted-policy'
import type {
  HostedAuthMethod,
  HostedAuthPolicyDenialReason,
  HostedAuthPolicyError,
} from './hosted-policy'

type PolicyDeniedIdentifier = {
  type: 'email' | 'phone' | 'username' | 'external_id' | 'unknown'
  value: string | null
}

type PolicyDeniedInput = {
  tenant: TenantVar
  method: HostedAuthMethod | 'social' | 'enterpriseSso' | 'guest'
  action: 'login' | 'user_creation' | 'availability' | 'domain_discovery'
  reason: HostedAuthPolicyDenialReason | 'domain_discovery_disabled'
  identifier?: PolicyDeniedIdentifier
  provider?: string
}

export function policyDeniedReason(error: unknown): HostedAuthPolicyDenialReason | null {
  return isHostedAuthPolicyError(error) ? error.policyReason : null
}

export function throwUnlessPolicyDenied(error: unknown): HostedAuthPolicyError {
  if (!isHostedAuthPolicyError(error)) throw error
  return error
}

function requestIp(c: Context<XidHonoEnv>): string | null {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null
}

function methodPayload(input: PolicyDeniedInput): Record<string, unknown> {
  return {
    method: input.method,
    action: input.action,
    reason: input.reason,
    provider: input.provider ?? null,
  }
}

async function identifierPayload(
  tenantId: string,
  identifier: PolicyDeniedIdentifier | undefined,
): Promise<Record<string, unknown>> {
  if (!identifier?.value) return { identifierType: identifier?.type ?? null }
  const value = identifier.value.trim().toLowerCase()
  return {
    identifierType: identifier.type,
    identifierHash: await sha256Hex(`${tenantId}:${identifier.type}:${value}`),
    emailDomain: identifier.type === 'email' ? emailDomain(value) : null,
  }
}

export async function recordHostedAuthPolicyDenied(
  c: Context<XidHonoEnv>,
  input: PolicyDeniedInput,
): Promise<void> {
  await c.env.AUDIT_QUEUE.send({
    tenantId: input.tenant.tenantId,
    action: 'auth.policy_denied',
    ts: Date.now(),
    payload: {
      ...methodPayload(input),
      ...(await identifierPayload(input.tenant.tenantId, input.identifier)),
      path: new URL(c.req.url).pathname,
      ip: requestIp(c),
    },
  })
}

export async function auditPolicyDeniedError(
  c: Context<XidHonoEnv>,
  error: unknown,
  input: Omit<PolicyDeniedInput, 'reason'>,
): Promise<HostedAuthPolicyError> {
  const policyError = throwUnlessPolicyDenied(error)
  await recordHostedAuthPolicyDenied(c, { ...input, reason: policyError.policyReason })
  return policyError
}
