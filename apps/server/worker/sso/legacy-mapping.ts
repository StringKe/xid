// Write-path normalization for legacy SSO attribute mappings (Management API create / PATCH).
// Server-owned secret material is never taken from the request body: it is derived from submitted
// plaintext or carried over from the previously stored mapping.

import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { publicHttpsUrlSchema } from '../lib/validate'
import { assertHeaderConnectionConfig, prepareHeaderProxySecret } from './header-proxy-secret'
import { LDAP_GATEWAY_SECRET_KEY, prepareLdapGatewaySecret } from './ldap-gateway-secret'
import { legacyObject, readLegacyConfigFromMapping } from './legacy-config'
import { isUsableLegacyTargetUrl } from './legacy-target-url'

// SWA vault keys are retired formats (credentials now live in swa_credentials); they are dropped
// on every write and never carried over.
const SERVER_OWNED_KEYS = [
  LDAP_GATEWAY_SECRET_KEY,
  '_swaCredentials',
  '_swaVault',
  '_swaVaultEnvelope',
] as const

const FORM_FIELD_NAME = /^[A-Za-z0-9_.:[\]-]{1,128}$/

function invalidLegacy(paramName: string, longMessage?: string): AppError {
  return new AppError('validation_failed', {
    httpStatus: 422,
    meta: { paramName },
    ...(longMessage ? { longMessage } : {}),
  })
}

function assertWsfedConfig(legacy: Record<string, unknown>): void {
  if (
    typeof legacy['wsfedRealm'] !== 'string' ||
    !legacy['wsfedRealm'].trim() ||
    typeof legacy['wsfedReplyUrl'] !== 'string' ||
    !v.safeParse(publicHttpsUrlSchema, legacy['wsfedReplyUrl']).success
  ) {
    throw invalidLegacy('attribute_mapping._legacy')
  }
  if (
    legacy['wsfedAllowIdpInitiated'] !== undefined &&
    typeof legacy['wsfedAllowIdpInitiated'] !== 'boolean'
  ) {
    throw invalidLegacy('attribute_mapping._legacy.wsfedAllowIdpInitiated')
  }
}

function assertSwaConfig(legacy: Record<string, unknown>): void {
  if (!isUsableLegacyTargetUrl(legacy['swaTargetUrl'])) {
    throw invalidLegacy('attribute_mapping._legacy.swaTargetUrl', 'swa_target_url_required')
  }
  for (const key of ['swaUsernameField', 'swaPasswordField'] as const) {
    const value = legacy[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !FORM_FIELD_NAME.test(value)) {
      throw invalidLegacy(`attribute_mapping._legacy.${key}`)
    }
  }
  const config = readLegacyConfigFromMapping({ _legacy: legacy })
  if (config.swaUsernameField === config.swaPasswordField) {
    throw invalidLegacy('attribute_mapping._legacy.swaPasswordField')
  }
}

export async function prepareLegacyAttributeMapping(
  protocol: string,
  attributeMapping: Record<string, unknown>,
  previousMapping: Record<string, unknown> | null | undefined,
  env: { KEK: string },
): Promise<Record<string, unknown>> {
  const prepared: Record<string, unknown> = { ...attributeMapping }
  for (const key of SERVER_OWNED_KEYS) delete prepared[key]
  const legacy = legacyObject(attributeMapping)
  const previousLegacy = legacyObject(previousMapping)

  if (protocol === 'header') await prepareHeaderProxySecret(legacy, previousLegacy)
  if (protocol === 'ldap') {
    prepared[LDAP_GATEWAY_SECRET_KEY] = await prepareLdapGatewaySecret({
      legacy,
      previousLegacy,
      previousEnvelope: previousMapping?.[LDAP_GATEWAY_SECRET_KEY],
      env,
    })
  }
  if (protocol === 'wsfed') assertWsfedConfig(legacy)
  if (protocol === 'swa') assertSwaConfig(legacy)

  prepared['_legacy'] = legacy
  assertHeaderConnectionConfig(protocol, prepared)
  return prepared
}
