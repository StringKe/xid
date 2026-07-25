import { describe, it } from 'vitest'
import { runProductionEnterpriseSsoSmoke } from './harness/smoke-production-enterprise-sso.mjs'

describe('production enterprise SSO smoke', () => {
  it('passes a real IdP callback on production', async () => {
    await runProductionEnterpriseSsoSmoke()
  }, 300000)
})
