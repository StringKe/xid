import { describe, expect, it } from 'vitest'
import { classifyApiError } from './api-errors'

describe('classifyApiError', () => {
  it('collapses account-revealing codes on credential endpoints to the opaque credential error', () => {
    for (const code of ['invalid_request', 'not_found', 'unauthorized', 'forbidden'] as const) {
      expect(classifyApiError({ code }, { surface: 'credential' })).toEqual({
        code: 'invalid_credentials',
      })
    }
  })

  it('reports locked, suspended and banned accounts with one credential code', () => {
    for (const code of ['account_locked', 'account_suspended', 'account_banned'] as const) {
      expect(classifyApiError({ code }, { surface: 'credential' })).toEqual({
        code: 'account_locked',
      })
    }
  })

  it('keeps correctable credential-endpoint errors and their field', () => {
    expect(
      classifyApiError(
        { code: 'validation_failed', meta: { paramName: 'password' } },
        { surface: 'credential' },
      ),
    ).toEqual({ code: 'validation_failed', paramName: 'password' })
    expect(classifyApiError({ code: 'password_breached' }, { surface: 'credential' })).toEqual({
      code: 'password_breached',
    })
    expect(classifyApiError({ code: 'rate_limited' }, { surface: 'credential' })).toEqual({
      code: 'rate_limited',
    })
  })

  it('passes every code and field through on general endpoints', () => {
    expect(classifyApiError({ code: 'forbidden' }, { surface: 'general' })).toEqual({
      code: 'forbidden',
    })
    expect(
      classifyApiError(
        { code: 'validation_failed', meta: { paramName: 'redirectUris' } },
        { surface: 'general' },
      ),
    ).toEqual({ code: 'validation_failed', paramName: 'redirectUris' })
  })
})
