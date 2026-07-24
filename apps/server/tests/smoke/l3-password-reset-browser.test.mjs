import { describe, it } from 'vitest'
import { runL3PasswordResetBrowserSmoke } from './harness/smoke-l3-password-reset-browser.mjs'

describe('local L3 password reset browser smoke', () => {
  it('passes local browser password reset gates', async () => {
    await runL3PasswordResetBrowserSmoke()
  }, 600000)
})
