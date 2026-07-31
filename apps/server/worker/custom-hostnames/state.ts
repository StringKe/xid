import type { schema } from '@xid-kit/db'
import type { CloudflareCustomHostnameDetails } from '../lib/cloudflare-custom-hostnames'
import { CUSTOM_HOSTNAME_OWNERSHIP_TTL_MS } from '../lib/cloudflare-custom-hostnames'

type CustomHostnameRow = typeof schema.customHostnames.$inferSelect
export type CustomHostnameStatePatch = Partial<
  Pick<
    CustomHostnameRow,
    | 'cloudflareHostnameId'
    | 'status'
    | 'hostnameStatus'
    | 'sslStatus'
    | 'ownershipVerificationType'
    | 'ownershipVerificationName'
    | 'ownershipVerificationValue'
    | 'ownershipExpiresAt'
    | 'dcvDelegationRecords'
    | 'validationRecords'
    | 'verificationErrors'
    | 'activatedAt'
    | 'lastPolledAt'
  >
>

export function customHostnameLifecycleStatus(
  details: Pick<CloudflareCustomHostnameDetails, 'status' | 'sslStatus'>,
): 'active' | 'pending' {
  return details.status === 'active' && details.sslStatus === 'active' ? 'active' : 'pending'
}

export function customHostnameStatePatch(
  details: CloudflareCustomHostnameDetails,
  existing: Pick<
    CustomHostnameRow,
    | 'activatedAt'
    | 'ownershipExpiresAt'
    | 'ownershipVerificationName'
    | 'ownershipVerificationType'
    | 'ownershipVerificationValue'
  >,
  now: Date = new Date(),
): CustomHostnameStatePatch {
  const status = customHostnameLifecycleStatus(details)
  const ownershipVerified = details.status === 'active'
  const ownership = details.ownershipVerification
  return {
    cloudflareHostnameId: details.id,
    status,
    hostnameStatus: details.status,
    sslStatus: details.sslStatus,
    ownershipVerificationType: ownership?.type ?? existing.ownershipVerificationType ?? undefined,
    ownershipVerificationName: ownership?.name ?? existing.ownershipVerificationName ?? undefined,
    ownershipVerificationValue:
      ownership?.value ?? existing.ownershipVerificationValue ?? undefined,
    ownershipExpiresAt: ownershipVerified
      ? null
      : (existing.ownershipExpiresAt ?? new Date(now.getTime() + CUSTOM_HOSTNAME_OWNERSHIP_TTL_MS)),
    dcvDelegationRecords: details.dcvDelegationRecords,
    validationRecords: details.validationRecords,
    verificationErrors: details.verificationErrors,
    activatedAt: status === 'active' ? (existing.activatedAt ?? now) : existing.activatedAt,
    lastPolledAt: now,
  }
}
