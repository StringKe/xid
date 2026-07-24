import { describe, it, expect } from 'vitest'

import { webauthnError } from '../errors'

describe('webauthnError', () => {
  it('returns fuzzy 401 message for all verification failures', () => {
    const err = webauthnError('signature_invalid', 'audit detail')
    expect(err).toMatchObject({
      code: 'signature_invalid',
      message: 'WebAuthn verification failed',
      httpStatus: 401,
      longMessage: 'audit detail',
    })
  })

  it('omits longMessage when not provided', () => {
    const err = webauthnError('challenge_invalid')
    expect(err.longMessage).toBeUndefined()
  })
})
