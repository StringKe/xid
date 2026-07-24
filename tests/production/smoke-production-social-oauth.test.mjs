import { describe, it } from 'vitest'
import { runProductionSocialOauthSmoke } from './harness/smoke-production-social-oauth.mjs'

describe('production social OAuth smoke', () => {
  it('passes a real provider callback on production', async () => {
    await runProductionSocialOauthSmoke()
  }, 300000)
})
