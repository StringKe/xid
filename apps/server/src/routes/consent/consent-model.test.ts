import { describe, expect, it } from 'vitest'
import { splitConsentScopes } from './consent-model'

const scopes = (names: string[]) => names.map((name) => ({ name }))

describe('splitConsentScopes', () => {
  it('lists every requested scope on a first consent', () => {
    const result = splitConsentScopes({
      scopes: scopes(['openid', 'email']),
      previouslyGrantedScopes: [],
    })

    expect(result).toEqual({
      requested: ['openid', 'email'],
      added: ['openid', 'email'],
      alreadyAllowed: [],
      isReconsent: false,
    })
  })

  it('lists only new scopes when the user allowed some before', () => {
    const result = splitConsentScopes({
      scopes: scopes(['openid', 'email', 'phone', 'offline_access']),
      previouslyGrantedScopes: ['openid', 'email', 'profile'],
    })

    expect(result.added).toEqual(['phone', 'offline_access'])
    expect(result.alreadyAllowed).toEqual(['openid', 'email'])
    expect(result.isReconsent).toBe(true)
  })
})
