import {
  isApplicationSignUpIntent,
  isHostedAuthIntent,
  isProductSignUpIntent,
  type HostedAuthIntent,
} from './hosted-auth-intent'

const LOCAL_ORIGIN = 'https://xid.local'
const MAX_CONTINUE_PATH_LENGTH = 2048
const MAX_CLIENT_ID_LENGTH = 255
const MAX_AUTHZ_REQUEST_ID_LENGTH = 255

export function normalizeLocalContinuePath(value: string | null | undefined): string | null {
  if (
    !value ||
    value.length > MAX_CONTINUE_PATH_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    return null
  }
  try {
    const parsed = new URL(value, LOCAL_ORIGIN)
    if (parsed.origin !== LOCAL_ORIGIN) return null
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return null
  }
}

export function resolveApplicationAuthorizeContinuation(
  value: string | null | undefined,
  applicationClientId: string | null | undefined,
): string | null {
  const normalized = normalizeLocalContinuePath(value)
  const clientId = applicationClientId?.trim() ?? ''
  if (!normalized || !clientId || clientId.length > MAX_CLIENT_ID_LENGTH) return null

  const parsed = new URL(normalized, LOCAL_ORIGIN)
  const authzRequestIds = parsed.searchParams.getAll('authz_request_id')
  const clientIds = parsed.searchParams.getAll('client_id')
  const allowedKeys = new Set(['authz_request_id', 'client_id'])
  const hasUnexpectedKey = [...parsed.searchParams.keys()].some((key) => !allowedKeys.has(key))
  const authzRequestId = authzRequestIds[0] ?? ''

  if (
    parsed.pathname !== '/authorize' ||
    parsed.hash !== '' ||
    hasUnexpectedKey ||
    authzRequestIds.length !== 1 ||
    authzRequestId.length === 0 ||
    authzRequestId.length > MAX_AUTHZ_REQUEST_ID_LENGTH ||
    clientIds.length !== 1 ||
    clientIds[0] !== clientId
  ) {
    return null
  }
  return normalized
}

export function isAuthorizeContinuation(value: string | null | undefined): boolean {
  const normalized = normalizeLocalContinuePath(value)
  if (!normalized) return false
  return new URL(normalized, LOCAL_ORIGIN).pathname === '/authorize'
}

export type HostedAuthFlowResolution = {
  intent: HostedAuthIntent | null
  continuePath: string
  applicationClientId: string | null
  kind: 'local' | 'product-sign-up' | 'application' | 'invitation'
}

export function resolveHostedAuthFlow(input: {
  intent?: string | null
  continuePath?: string | null
  applicationClientId?: string | null
  hasInvitation?: boolean
}): HostedAuthFlowResolution | null {
  const rawIntent = input.intent?.trim() || null
  if (rawIntent !== null && !isHostedAuthIntent(rawIntent)) return null
  const intent = rawIntent as HostedAuthIntent | null
  const applicationClientId = input.applicationClientId?.trim() || null
  if (applicationClientId && applicationClientId.length > MAX_CLIENT_ID_LENGTH) return null
  const hasInvitation = input.hasInvitation === true

  const hasRawContinuePath = Boolean(input.continuePath)
  const normalizedContinuePath = normalizeLocalContinuePath(input.continuePath)
  if (hasRawContinuePath && normalizedContinuePath === null) return null

  if (
    (applicationClientId && (hasInvitation || isProductSignUpIntent(intent))) ||
    (isApplicationSignUpIntent(intent) && !applicationClientId)
  ) {
    return null
  }

  const continuePath = hasInvitation
    ? '/console'
    : isProductSignUpIntent(intent)
      ? '/create-organization'
      : (normalizedContinuePath ?? '/console')

  if (applicationClientId) {
    const applicationContinuation = resolveApplicationAuthorizeContinuation(
      continuePath,
      applicationClientId,
    )
    if (!applicationContinuation) return null
    return {
      intent,
      continuePath: applicationContinuation,
      applicationClientId,
      kind: 'application',
    }
  }
  if (isAuthorizeContinuation(continuePath)) return null
  return {
    intent,
    continuePath,
    applicationClientId: null,
    kind: hasInvitation
      ? 'invitation'
      : isProductSignUpIntent(intent)
        ? 'product-sign-up'
        : 'local',
  }
}
