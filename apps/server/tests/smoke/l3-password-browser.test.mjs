import { describe, it } from 'vitest'
import { runL3PasswordBrowserSmoke } from './harness/smoke-l3-password-browser.mjs'

describe('local L3 password browser smoke', () => {
  it('passes local browser password, social and enterprise SSO gates', async () => {
    await runL3PasswordBrowserSmoke()
  }, 900000)
})
