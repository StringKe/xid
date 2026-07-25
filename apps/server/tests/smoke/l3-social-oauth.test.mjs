import { describe, it } from 'vitest'
import { runL3SocialOAuthSmoke } from './harness/smoke-l3-social-oauth.mjs'

describe('local L3 social OAuth smoke', () => {
  it('passes fake Google/Apple/Microsoft/GitHub social OAuth callback gates', async () => {
    await runL3SocialOAuthSmoke()
  }, 600000)
})
