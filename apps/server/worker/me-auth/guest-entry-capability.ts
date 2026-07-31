import { base64UrlEncode } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { AppError } from '../lib/errors'
import { GUEST_ENTRY_CAPABILITY_TTL_MS } from '../lib/ttl'

export const GUEST_ENTRY_FLOW = 'root_staging_onboarding'

type GuestEntryCapabilityRecord = {
  version: 1
  tenantId: string
  flow: typeof GUEST_ENTRY_FLOW
  origin: string
}

function capabilityKey(token: string): string {
  return `guest-entry:${token}`
}

function capabilityStub(env: Env, token: string): DurableObjectStub {
  const namespace = env.WEBAUTHN_CHALLENGE
  return namespace.get(namespace.idFromName(capabilityKey(token)))
}

function isCapabilityRecord(value: unknown): value is GuestEntryCapabilityRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['version'] === 1 &&
    typeof record['tenantId'] === 'string' &&
    record['tenantId'].length > 0 &&
    record['flow'] === GUEST_ENTRY_FLOW &&
    typeof record['origin'] === 'string' &&
    record['origin'].length > 0
  )
}

export function isRootGuestOnboardingTenant(tenant: TenantContext): boolean {
  return (
    tenant.resolution?.kind === 'instance_entry' &&
    tenant.resolution.unresolvedRoot === true &&
    tenant.customHostname === undefined
  )
}

export async function createGuestEntryCapability(input: {
  env: Env
  tenantId: string
  origin: string
}): Promise<string> {
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const key = capabilityKey(token)
  const value: GuestEntryCapabilityRecord = {
    version: 1,
    tenantId: input.tenantId,
    flow: GUEST_ENTRY_FLOW,
    origin: input.origin,
  }
  const response = await capabilityStub(input.env, token).fetch('https://challenge-store/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      value: JSON.stringify(value),
      ttlMs: GUEST_ENTRY_CAPABILITY_TTL_MS,
    }),
  })
  if (response.status !== 201) throw new AppError('server_error')
  return token
}

export async function consumeGuestEntryCapability(input: {
  env: Env
  token: string
  tenantId: string
  origin: string
}): Promise<boolean> {
  const key = capabilityKey(input.token)
  const response = await capabilityStub(input.env, input.token).fetch(
    'https://challenge-store/consume',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    },
  )
  if (response.status === 404 || response.status === 410) return false
  if (response.status !== 200) throw new AppError('server_error')

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  if (typeof body !== 'object' || body === null) throw new AppError('server_error')
  const encoded = (body as Record<string, unknown>)['value']
  if (typeof encoded !== 'string') throw new AppError('server_error')

  let record: unknown
  try {
    record = JSON.parse(encoded)
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  if (!isCapabilityRecord(record)) throw new AppError('server_error')
  return record.tenantId === input.tenantId && record.origin === input.origin
}
