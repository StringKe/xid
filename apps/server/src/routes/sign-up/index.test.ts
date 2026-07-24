import { describe, expect, it } from 'vitest'
import { signUpRedirectSearch } from './redirect'

describe('signUpRedirectSearch', () => {
  it('redirects sign-up to unified sign-in intent', () => {
    expect(signUpRedirectSearch({})).toEqual({ intent: 'sign-up' })
  })

  it('preserves continue over redirect', () => {
    expect(
      signUpRedirectSearch({
        continue: '/console',
        redirect: '/account/security',
      }),
    ).toEqual({ intent: 'sign-up', continue: '/console' })
  })

  it('maps redirect to continue for legacy query callers', () => {
    expect(signUpRedirectSearch({ redirect: '/console/settings' })).toEqual({
      intent: 'sign-up',
      continue: '/console/settings',
    })
  })

  it('preserves locale for the unified sign-in entry', () => {
    expect(signUpRedirectSearch({ locale: 'en', redirect: '/console/settings' })).toEqual({
      intent: 'sign-up',
      continue: '/console/settings',
      locale: 'en',
    })
  })
})
