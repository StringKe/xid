import { describe, expect, it } from 'vitest'
import { XidClient } from '../client'
import * as CoreSdk from '../index'

const EXPECTED_EXPORTS = [
  'PACKAGE',
  'XidClient',
  'XidStore',
  'TokenManager',
  'XidApiClient',
  'XidNetworkError',
  'makeXidError',
  'isXidErrorShape',
  'decodeTokenClaims',
  'isTokenExpiring',
  'SESSION_STATUS',
  'CLIENT_STATUS',
] as const

describe('@xid-kit/core public exports', () => {
  it('exports the documented public surface', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(CoreSdk, `missing export ${name}`).toHaveProperty(name)
    }
  })

  it('identifies the package name', () => {
    expect(CoreSdk.PACKAGE).toBe('@xid-kit/core')
  })

  it('exposes Management API helpers on XidClient', () => {
    const methods = [
      'listApiKeys',
      'createApiKey',
      'revokeApiKey',
      'listUsers',
      'getUser',
      'listOrganizations',
      'listSessions',
    ] as const
    for (const method of methods) {
      expect(XidClient.prototype, `missing method ${method}`).toHaveProperty(method)
    }
  })
})
