import { describe, expect, it } from 'vitest'
import { signInRedirectTarget } from './require-auth-redirect'

describe('signInRedirectTarget', () => {
  it('keeps the original protected target as continue', () => {
    expect(signInRedirectTarget('/console/platform/organizations', '?q=acme', '#top')).toBe(
      '/sign-in?continue=%2Fconsole%2Fplatform%2Forganizations%3Fq%3Dacme%23top',
    )
  })

  it('keeps an existing sign-in continue query unchanged', () => {
    expect(signInRedirectTarget('/sign-in', '?continue=%2Fconsole', '')).toBe(
      '/sign-in?continue=%2Fconsole',
    )
  })
})
