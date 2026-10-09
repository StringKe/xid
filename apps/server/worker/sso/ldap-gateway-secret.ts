// Each LDAP connection authenticates to its own HTTP gateway with its own bearer secret. The admin
// submits `_legacy.ldapGatewaySecret` once; it is stored only as a KEK envelope under
// LDAP_GATEWAY_SECRET_KEY and never returned.

import { AppError } from '../lib/errors'
import { isUsableLegacyTargetUrl } from './legacy-target-url'
import {
  isStoredEnvelope,
  openLegacySecret,
  sealLegacySecret,
  type StoredEnvelope,
} from './legacy-secret-envelope'

export const LDAP_GATEWAY_SECRET_KEY = '_ldapGatewaySecretEnvelope'

const MIN_LDAP_GATEWAY_SECRET_LENGTH = 32
const MAX_LDAP_GATEWAY_SECRET_LENGTH = 1024

function invalid(paramName: string, longMessage: string): AppError {
  return new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName: `attribute_mapping._legacy.${paramName}` },
    longMessage,
  })
}

// Validates the gateway settings in `legacy` (mutating it to drop the plaintext secret) and
// returns the envelope to persist.
export async function prepareLdapGatewaySecret(input: {
  legacy: Record<string, unknown>
  previousLegacy: Record<string, unknown>
  previousEnvelope: unknown
  env: { KEK: string }
}): Promise<StoredEnvelope> {
  const { legacy, previousLegacy, previousEnvelope, env } = input
  const submitted = legacy['ldapGatewaySecret']
  delete legacy['ldapGatewaySecret']
  if (!isUsableLegacyTargetUrl(legacy['ldapGatewayUrl'])) {
    throw invalid('ldapGatewayUrl', 'ldap_gateway_url_required')
  }
  if (submitted !== undefined) {
    if (
      typeof submitted !== 'string' ||
      submitted.trim().length < MIN_LDAP_GATEWAY_SECRET_LENGTH ||
      submitted.length > MAX_LDAP_GATEWAY_SECRET_LENGTH
    ) {
      throw invalid('ldapGatewaySecret', 'ldap_gateway_secret_weak')
    }
    return sealLegacySecret(env, submitted)
  }
  // A stored secret stays bound to the gateway it was issued for.
  const sameGateway = legacy['ldapGatewayUrl'] === previousLegacy['ldapGatewayUrl']
  if (sameGateway && isStoredEnvelope(previousEnvelope)) return previousEnvelope
  throw invalid('ldapGatewaySecret', 'ldap_gateway_secret_required')
}

export async function readLdapGatewaySecret(
  env: { KEK: string },
  attributeMapping: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  const envelope = attributeMapping?.[LDAP_GATEWAY_SECRET_KEY]
  if (!isStoredEnvelope(envelope)) return null
  return openLegacySecret(env, envelope)
}

export function ldapGatewaySecretConfigured(
  attributeMapping: Record<string, unknown> | null | undefined,
): boolean {
  return isStoredEnvelope(attributeMapping?.[LDAP_GATEWAY_SECRET_KEY])
}
