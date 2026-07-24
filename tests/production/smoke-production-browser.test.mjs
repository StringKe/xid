import { describe, it } from 'vitest'
import { runProductionBrowserSmoke } from './harness/smoke-production-browser.mjs'

describe('production browser smoke', () => {
  it('passes browser auth, console, account and SDK gates on production', async () => {
    await runProductionBrowserSmoke()
  }, 900000)
})
