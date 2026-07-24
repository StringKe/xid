import { describe, it } from 'vitest'
import { runL3PasskeyBrowserSmoke } from './harness/smoke-l3-passkey-browser.mjs'

describe('local L3 passkey browser smoke', () => {
  it('passes local browser passkey registration and sign-in gates', async () => {
    await runL3PasskeyBrowserSmoke()
  }, 600000)
})
