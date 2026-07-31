// Invitation capability format:
// xid_inv_v1.<base64url tenant_id>.<256-bit random secret>.
//
// The locator only selects a candidate Tenant. The database stores SHA-256 of the complete token,
// so changing the locator also changes the credential and cannot pass the selected Tenant's scoped
// tokenHash lookup. This avoids a global token lookup and does not require another signing secret.

import { base64UrlDecodeToString, base64UrlEncode, base64UrlEncodeString } from '@xid-kit/crypto'

const PREFIX = 'xid_inv_v1'
export const INVITATION_TOKEN_VERSION = 'locator_v1' as const
const SECRET_BYTES = 32
const SECRET_LENGTH = 43
const MAX_TENANT_ID_LENGTH = 256
const BASE64URL = /^[A-Za-z0-9_-]+$/

export function createTenantBoundInvitationToken(tenantId: string): string {
  const normalizedTenantId = tenantId.trim()
  if (!normalizedTenantId || normalizedTenantId.length > MAX_TENANT_ID_LENGTH) {
    throw new TypeError('tenantId is required')
  }
  const locator = base64UrlEncodeString(normalizedTenantId)
  const secret = base64UrlEncode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))
  return `${PREFIX}.${locator}.${secret}`
}

export function invitationTenantIdFromToken(rawToken: string): string | null {
  const [prefix, locator, secret, extra] = rawToken.trim().split('.')
  if (
    prefix !== PREFIX ||
    !locator ||
    !secret ||
    extra !== undefined ||
    !BASE64URL.test(locator) ||
    !BASE64URL.test(secret) ||
    secret.length !== SECRET_LENGTH
  ) {
    return null
  }
  try {
    const tenantId = base64UrlDecodeToString(locator)
    const containsControlCharacter = [...tenantId].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
    if (
      !tenantId ||
      tenantId !== tenantId.trim() ||
      tenantId.length > MAX_TENANT_ID_LENGTH ||
      containsControlCharacter
    ) {
      return null
    }
    return tenantId
  } catch {
    return null
  }
}
