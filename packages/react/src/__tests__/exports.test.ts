import { describe, expect, it } from 'vitest'
import * as ReactSdk from '../index'

const EXPECTED_EXPORTS = [
  'XidProvider',
  'useXidContext',
  'useAuth',
  'useUser',
  'useSession',
  'useSessionList',
  'useSignIn',
  'useUpgradeGuest',
  'useOrganization',
  'useOrganizationList',
  'useAPIKeys',
  'SignedIn',
  'SignedOut',
  'Protect',
  'XidLoaded',
  'XidLoading',
  'XidFailed',
  'XidDegraded',
  'AuthenticateWithRedirectCallback',
  'RedirectToSignIn',
  'RedirectToSignUp',
  'RedirectToUserProfile',
  'RedirectToOrganizationProfile',
  'RedirectToCreateOrganization',
  'SignInButton',
  'SignOutButton',
  'SignUpButton',
  'SignIn',
  'SignUp',
  'UserAvatar',
  'UserButton',
  'UserProfile',
  'GuestUpgradeBanner',
  'OrganizationSwitcher',
  'OrganizationProfile',
  'CreateOrganization',
  'OrganizationList',
] as const

describe('@xid-kit/react public exports', () => {
  it('exports the documented public surface', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(ReactSdk, `missing export ${name}`).toHaveProperty(name)
    }
  })

  it('does not export removed tenant-scoped client helpers', () => {
    expect(ReactSdk).not.toHaveProperty('useSignUp')
    expect(ReactSdk).not.toHaveProperty('useTenant')
  })
})
