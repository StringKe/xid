import { describe, expect, it } from 'vitest'
import * as BackendSdk from '../index'

const EXPECTED_EXPORTS = [
  'PACKAGE',
  'AppError',
  'BACKEND_ERROR_CODES',
  'toVerifyKeySet',
  'JwksCache',
  'verifyToken',
  'authenticateRequest',
  'exchangeSessionToken',
  'hasCoreSessionCookie',
  'verifyWebhook',
] as const

describe('@xid-kit/backend public exports', () => {
  it('exports the documented public surface', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(BackendSdk, `missing export ${name}`).toHaveProperty(name)
    }
  })

  it('identifies the package name', () => {
    expect(BackendSdk.PACKAGE).toBe('@xid-kit/backend')
  })
})
