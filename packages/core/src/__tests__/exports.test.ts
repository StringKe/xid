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
  'isGuestUser',
  'isGuestToken',
  'isSameUser',
  'b64urlToBytes',
  'bytesToB64url',
  'createPasskeyCredential',
  'registrationOptionsToPublicKey',
  'SESSION_STATUS',
  'CLIENT_STATUS',
  'SILENT_AUTHORIZATION_ERRORS',
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

  it('exposes the guest passkey upgrade entry on XidClient', () => {
    expect(XidClient.prototype).toHaveProperty('upgradeGuestWithPasskey')
  })

  it('exposes the silent re-authentication entries on XidClient', () => {
    expect(XidClient.prototype).toHaveProperty('signInSilent')
    expect(XidClient.prototype).toHaveProperty('signInSilentWithRedirect')
  })
})
