import { OUTBOUND_CONSOLE_PRESETS } from '@xid-kit/protocol'
import { describe, expect, it } from 'vitest'
import {
  INBOUND_IDP_PRESETS,
  LEGACY_INBOUND_PRESETS,
  OUTBOUND_SAAS_PRESETS,
  presetKeyFromAttributeMapping,
  withPresetAttributeMapping,
} from '../provider-presets'

describe('provider-presets', () => {
  it('exposes inbound IdP presets with runbook paths', () => {
    expect(Object.keys(INBOUND_IDP_PRESETS)).toHaveLength(10)
    for (const preset of Object.values(INBOUND_IDP_PRESETS)) {
      expect(preset.runbookPath.startsWith('docs/protocols/runbooks/')).toBe(true)
      expect(preset.attributeMapping.email).toBeTruthy()
    }
  })

  it('exposes outbound SaaS presets with ACS placeholders', () => {
    expect(Object.keys(OUTBOUND_SAAS_PRESETS)).toHaveLength(6)
    for (const preset of Object.values(OUTBOUND_SAAS_PRESETS)) {
      expect(preset.acsUrlPlaceholder).toContain('https://')
      expect(preset.spEntityId).toContain('https://')
    }
  })

  it('ships no example hosts or secrets in legacy presets', () => {
    const serialized = JSON.stringify(LEGACY_INBOUND_PRESETS)

    expect(serialized).not.toMatch(/example\.com|Secret|vaultCredentialRef/)
  })

  it('requires only the assertion signature for IdPs that sign the assertion by default', () => {
    const entra = INBOUND_IDP_PRESETS['microsoft-entra']
    const keycloak = INBOUND_IDP_PRESETS.keycloak

    expect([entra.wantAuthnResponseSigned, entra.wantAssertionsSigned]).toEqual([false, true])
    expect([keycloak.wantAuthnResponseSigned, keycloak.wantAssertionsSigned]).toEqual([true, false])
    expect(entra.idpMetadataUrlTemplate).toContain('?appid={appId}')
  })

  it('leaves the metadata URL empty for IdPs that only offer a metadata file', () => {
    expect(INBOUND_IDP_PRESETS['google-workspace'].idpMetadataUrlTemplate).toBeUndefined()
    expect(INBOUND_IDP_PRESETS.jumpcloud.idpMetadataUrlTemplate).toBeUndefined()
  })

  it('uses the documented Entity ID formats for GitHub and Atlassian', () => {
    expect(OUTBOUND_SAAS_PRESETS['github-enterprise'].spEntityId).toBe(
      'https://github.com/enterprises/{enterprise}',
    )
    expect(OUTBOUND_SAAS_PRESETS.atlassian.acsUrlPlaceholder).toBe(
      'https://auth.atlassian.com/login/callback?connection=saml-{connectionId}',
    )
  })

  it('round-trips preset keys in attribute mapping', () => {
    const mapping = withPresetAttributeMapping('slack', { email: 'email' })
    expect(presetKeyFromAttributeMapping(mapping)).toBe('slack')
  })

  it('keeps console outbound presets aligned with server presets', () => {
    expect(OUTBOUND_CONSOLE_PRESETS).toHaveLength(Object.keys(OUTBOUND_SAAS_PRESETS).length)
    for (const consolePreset of OUTBOUND_CONSOLE_PRESETS) {
      const serverPreset =
        OUTBOUND_SAAS_PRESETS[consolePreset.key as keyof typeof OUTBOUND_SAAS_PRESETS]
      expect(serverPreset).toBeTruthy()
      expect(consolePreset.entityId).toBe(serverPreset.spEntityId)
      expect(consolePreset.acsUrl).toBe(serverPreset.acsUrlPlaceholder)
      if (serverPreset.oidcRedirectPlaceholder) {
        expect(consolePreset.oidcRedirectPlaceholder).toBe(serverPreset.oidcRedirectPlaceholder)
      }
    }
  })
})
