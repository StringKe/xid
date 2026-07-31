import type { XidErrorCode } from '@xid-kit/types'
import { isHostedAuthIntent, type HostedAuthIntent } from '../../shared/hosted-auth-intent'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import { AppError } from '../lib/errors'

const FLOW_VERSION = 1
const MAX_CLIENT_ID_LENGTH = 255
const MAX_INVITATION_ID_LENGTH = 255
const MAX_SERIALIZED_FLOW_LENGTH = 4096

export type PasswordlessFlowContext = {
  version: typeof FLOW_VERSION
  intent: HostedAuthIntent | null
  continuePath: string
  applicationClientId: string | null
  invitationId: string | null
}

function invalid(code: XidErrorCode): never {
  throw new AppError(code)
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
  code: XidErrorCode,
): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return invalid(code)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return invalid(code)
  return trimmed
}

export function createPasswordlessFlowContext(opts: {
  intent?: string | null
  continuePath?: string | null
  applicationClientId?: string | null
  invitationId?: string | null
}): PasswordlessFlowContext {
  const invitationId = opts.invitationId?.trim() || null
  if (invitationId !== null && invitationId.length > MAX_INVITATION_ID_LENGTH) {
    invalid('invalid_request')
  }
  const resolved = resolveHostedAuthFlow({
    intent: opts.intent,
    continuePath: opts.continuePath,
    applicationClientId: opts.applicationClientId,
    hasInvitation: invitationId !== null,
  })
  if (!resolved) invalid('invalid_request')

  return {
    version: FLOW_VERSION,
    intent: resolved.intent,
    continuePath: resolved.continuePath,
    applicationClientId: resolved.applicationClientId,
    invitationId,
  }
}

export function serializePasswordlessFlowContext(flow: PasswordlessFlowContext): string {
  return JSON.stringify(flow)
}

export function parsePasswordlessFlowContext(
  value: string | null | undefined,
  invalidCode: XidErrorCode,
): PasswordlessFlowContext {
  if (!value || value.length > MAX_SERIALIZED_FLOW_LENGTH) return invalid(invalidCode)
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return invalid(invalidCode)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(invalidCode)
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record)
  const expectedKeys = new Set([
    'version',
    'intent',
    'continuePath',
    'applicationClientId',
    'invitationId',
  ])
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    return invalid(invalidCode)
  }
  if (record['version'] !== FLOW_VERSION) return invalid(invalidCode)

  const rawIntent = record['intent']
  if (rawIntent !== null && (typeof rawIntent !== 'string' || !isHostedAuthIntent(rawIntent))) {
    return invalid(invalidCode)
  }
  const applicationClientId = optionalBoundedString(
    record['applicationClientId'],
    MAX_CLIENT_ID_LENGTH,
    invalidCode,
  )
  const invitationId = optionalBoundedString(
    record['invitationId'],
    MAX_INVITATION_ID_LENGTH,
    invalidCode,
  )
  if (typeof record['continuePath'] !== 'string') return invalid(invalidCode)
  const resolved = resolveHostedAuthFlow({
    intent: rawIntent,
    continuePath: record['continuePath'],
    applicationClientId,
    hasInvitation: invitationId !== null,
  })
  if (
    !resolved ||
    resolved.intent !== rawIntent ||
    resolved.continuePath !== record['continuePath'] ||
    resolved.applicationClientId !== applicationClientId
  ) {
    return invalid(invalidCode)
  }

  return {
    version: FLOW_VERSION,
    intent: resolved.intent,
    continuePath: resolved.continuePath,
    applicationClientId: resolved.applicationClientId,
    invitationId,
  }
}
