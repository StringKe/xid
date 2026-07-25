import { OUTBOUND_CONSOLE_PRESETS } from '@xid-kit/protocol'
import { describe, expect, it } from 'vitest'
import {
  INBOUND_IDP_PRESETS,
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
