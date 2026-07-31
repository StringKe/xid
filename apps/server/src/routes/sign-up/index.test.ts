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

  it('passes through whitelisted auth-flow params', () => {
    expect(
      signUpRedirectSearch({
        invitation_token: 'invite-1',
        client_id: 'client-1',
        organization_id: 'org-1',
        authz_request_id: 'authz-1',
      }),
    ).toEqual({
      intent: 'sign-up',
      invitation_token: 'invite-1',
      client_id: 'client-1',
      organization_id: 'org-1',
      authz_request_id: 'authz-1',
    })
  })

  it('drops params outside the whitelist', () => {
    const search = {
      continue: '/console',
      verified: '1',
      reauthenticate: '1',
      utm_source: 'campaign',
    } as unknown as Parameters<typeof signUpRedirectSearch>[0]

    expect(signUpRedirectSearch(search)).toEqual({ intent: 'sign-up', continue: '/console' })
  })
})
