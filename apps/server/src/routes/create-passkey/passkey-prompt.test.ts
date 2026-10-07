import { describe, expect, it } from 'vitest'
import {
  PASSKEY_PROMPT_DISMISSED_KEY,
  readPromptDismissed,
  shouldOfferPasskey,
  writePromptDismissed,
} from './passkey-prompt'

const base = {
  serverEligible: undefined,
  passkeyCount: 0,
  passkeyMethodEnabled: true,
  browserSupportsPasskeys: true,
  dismissed: false,
}

describe('shouldOfferPasskey', () => {
  it('follows the server eligibility field when the deployment provides it', () => {
    expect(shouldOfferPasskey({ ...base, serverEligible: false })).toBe(false)
    expect(shouldOfferPasskey({ ...base, serverEligible: true, passkeyCount: 3 })).toBe(true)
  })

  it('offers a passkey to a user with none when the server field is absent', () => {
    expect(shouldOfferPasskey(base)).toBe(true)
    expect(shouldOfferPasskey({ ...base, passkeyCount: 1 })).toBe(false)
  })

  it('never offers after Not now in this browser', () => {
    expect(shouldOfferPasskey({ ...base, dismissed: true, serverEligible: true })).toBe(false)
  })

  it('never offers when the tenant disabled passkeys or the browser lacks support', () => {
    expect(shouldOfferPasskey({ ...base, passkeyMethodEnabled: false })).toBe(false)
    expect(shouldOfferPasskey({ ...base, browserSupportsPasskeys: false })).toBe(false)
  })

  it('waits while the passkey list is still loading', () => {
    expect(shouldOfferPasskey({ ...base, passkeyCount: undefined })).toBe('unknown')
  })
})

describe('Not now storage', () => {
  it('records the dismissal time under the documented key', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }

    writePromptDismissed(storage, Date.UTC(2026, 9, 7))

    expect(values.get(PASSKEY_PROMPT_DISMISSED_KEY)).toBe('2026-10-07T00:00:00.000Z')
    expect(readPromptDismissed(storage)).toBe(true)
  })
})
