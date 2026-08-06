# React SDK

`@xid-kit/react` provides React 19 provider, hooks, control components, and UI components for customer application integration. Depends on `@xid-kit/core`; does not perform protocol signing or token verification.

## Install

Registry status is `UNPUBLISHED`: local release artifacts are verified, but no npm publication has
been performed or authorized. The registry command below is post-publication only and becomes valid
after an independently verified authorized release. Until then, install from a source checkout or
audited tarball as described in [SDK Distribution](./distribution.md).

```sh
# Post-publication only
pnpm add @xid-kit/react
```

Peer dependency: React 19.

## Quickstart

```tsx
import { XidProvider, useAuth, SignedIn, SignedOut, SignInButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://xid.dev"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
      <Layout />
    </XidProvider>
  )
}

function Layout() {
  const { isLoaded, isSignedIn, userId } = useAuth()
  if (!isLoaded) return null
  return (
    <div>
      <SignedIn>Welcome, {userId}</SignedIn>
      <SignedOut>
        <SignInButton />
      </SignedOut>
    </div>
  )
}
```

## Exported API

### Provider

| Export             | Kind      | Description                                                               |
| ------------------ | --------- | ------------------------------------------------------------------------- |
| `XidProvider`      | component | Root provider; wraps the application to supply XID context                |
| `XidProviderProps` | type      | Core `same-origin` or `oidc` client options plus children                 |
| `useXidContext`    | hook      | Access the raw `XidContextValue` (advanced use; prefer typed hooks below) |
| `XidContextValue`  | type      | Shape of the context value exposed by `XidProvider`                       |

### Hooks

| Export                      | Kind | Returns                                                           |
| --------------------------- | ---- | ----------------------------------------------------------------- |
| `useAuth`                   | hook | `isLoaded`, `isSignedIn`, `userId`, `signOut`, `getToken`         |
| `useUser`                   | hook | `isLoaded`, `isSignedIn`, `user: XidUser \| null`                 |
| `useSession`                | hook | `isLoaded`, `isSignedIn`, `session: XidSession \| null`           |
| `useSessionList`            | hook | `isLoaded`, `sessions`, `setActive` for multi-session switcher    |
| `useSignIn`                 | hook | Helpers for Hosted Auth sign-in flow                              |
| `useOrganization`           | hook | `isLoaded`, `organization: XidOrganization \| null`, `membership` |
| `useOrganizationList`       | hook | `isLoaded`, `userMemberships` for organization switcher UI        |
| `useAPIKeys`                | hook | Management API key list and actions for console embeds            |
| `useUpgradeGuest`           | hook | `isLoaded`, `isGuest`, `pending`, `error`, `upgradeGuestWithPasskey` for the one-click guest passkey upgrade (same-origin mode only) |
| `UseAuthReturn`             | type | Return type of `useAuth`                                          |
| `UseUserReturn`             | type | Return type of `useUser`                                          |
| `UseSessionReturn`          | type | Return type of `useSession`                                       |
| `UseSessionListReturn`      | type | Return type of `useSessionList`                                   |
| `UseSignInReturn`           | type | Return type of `useSignIn`                                        |
| `UseOrganizationReturn`     | type | Return type of `useOrganization`                                  |
| `UseOrganizationListReturn` | type | Return type of `useOrganizationList`                              |
| `UseAPIKeysReturn`          | type | Return type of `useAPIKeys`                                       |

### Control components

| Export                                  | Kind      | Description                                                                                                            |
| --------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SignedIn`                              | component | Renders children only when a session is active                                                                         |
| `SignedOut`                             | component | Renders children only when no session is active                                                                        |
| `Protect`                               | component | Enforces an Organization membership role (`owner`, `admin`, or `member`) or permission check with optional fallback UI |
| `RedirectToSignIn`                      | component | Redirects anonymous users to Hosted Auth                                                                               |
| `RedirectToSignUp`                      | component | Redirects anonymous users to Hosted Auth sign-up entry                                                                 |
| `RedirectToUserProfile`                 | component | Redirects signed-in users to account profile                                                                           |
| `RedirectToOrganizationProfile`         | component | Redirects signed-in users to organization profile                                                                      |
| `RedirectToCreateOrganization`          | component | Redirects signed-in users to organization creation                                                                     |
| `AuthenticateWithRedirectCallback`      | component | Handles OAuth redirect callback in customer apps                                                                       |
| `SignInButton`                          | component | Triggers Hosted Auth sign-in flow                                                                                      |
| `SignOutButton`                         | component | Triggers sign-out                                                                                                      |
| `SignUpButton`                          | component | Triggers Hosted Auth sign-up flow                                                                                      |
| `XidLoaded`                             | component | Renders children after SDK hydration (status ready/degraded)                                                           |
| `XidLoading`                            | component | Renders children while SDK is loading (isLoaded === false)                                                             |
| `XidFailed`                             | component | Renders children on unrecoverable SDK load error                                                                       |
| `XidDegraded`                           | component | Renders children when SDK is in degraded state                                                                         |
| `SignedInProps`                         | type      | Props for `SignedIn`                                                                                                   |
| `SignedOutProps`                        | type      | Props for `SignedOut`                                                                                                  |
| `ProtectProps`                          | type      | Props for `Protect`: `OrganizationMembershipRole`, permission, fallback                                                |
| `RedirectToSignInProps`                 | type      | Props for `RedirectToSignIn`                                                                                           |
| `RedirectToSignUpProps`                 | type      | Props for `RedirectToSignUp`                                                                                           |
| `RedirectToUserProfileProps`            | type      | Props for `RedirectToUserProfile`                                                                                      |
| `RedirectToOrganizationProfileProps`    | type      | Props for `RedirectToOrganizationProfile`                                                                              |
| `RedirectToCreateOrganizationProps`     | type      | Props for `RedirectToCreateOrganization`                                                                               |
| `AuthenticateWithRedirectCallbackProps` | type      | Props for `AuthenticateWithRedirectCallback`                                                                           |
| `SignInButtonProps`                     | type      | Props for `SignInButton`                                                                                               |
| `SignOutButtonProps`                    | type      | Props for `SignOutButton`                                                                                              |
| `SignUpButtonProps`                     | type      | Props for `SignUpButton`                                                                                               |
| `XidLoadedProps`                        | type      | Props for `XidLoaded`                                                                                                  |
| `XidLoadingProps`                       | type      | Props for `XidLoading`                                                                                                 |
| `XidFailedProps`                        | type      | Props for `XidFailed`                                                                                                  |
| `XidDegradedProps`                      | type      | Props for `XidDegraded`                                                                                                |

### UI components

| Export                      | Kind      | Description                                   |
| --------------------------- | --------- | --------------------------------------------- |
| `SignIn`                    | component | Embedded sign-in panel (Hosted Auth)          |
| `SignUp`                    | component | Embedded sign-up panel                        |
| `UserAvatar`                | component | User avatar image with fallback initials      |
| `UserButton`                | component | Avatar menu: session switch and sign-out      |
| `UserProfile`               | component | Account security and profile management panel |
| `OrganizationSwitcher`      | component | Active organization selector                  |
| `OrganizationProfile`       | component | Members, roles, and SSO admin embed           |
| `CreateOrganization`        | component | Organization creation flow                    |
| `OrganizationList`          | component | List of user's organizations for switcher UI  |
| `GuestUpgradeBanner`        | component | Prompts an anonymous (guest) user to convert to a permanent account |
| `SignInProps`               | type      | Props for `SignIn`                            |
| `SignUpProps`               | type      | Props for `SignUp`                            |
| `UserAvatarProps`           | type      | Props for `UserAvatar`                        |
| `UserButtonProps`           | type      | Props for `UserButton`                        |
| `UserProfileProps`          | type      | Props for `UserProfile`                       |
| `OrganizationSwitcherProps` | type      | Props for `OrganizationSwitcher`              |
| `OrganizationProfileProps`  | type      | Props for `OrganizationProfile`               |
| `CreateOrganizationProps`   | type      | Props for `CreateOrganization`                |
| `OrganizationListProps`     | type      | Props for `OrganizationList`                  |

### Appearance

| Export                | Kind | Description                                                  |
| --------------------- | ---- | ------------------------------------------------------------ |
| `Appearance`          | type | Top-level appearance config: variables and element overrides |
| `AppearanceVariables` | type | CSS variable overrides for white-label theming               |
| `AppearanceElements`  | type | Per-element class name overrides                             |

## Not yet implemented

The following are designed and committed to the public roadmap but are not exported from the current package. Do not assume availability:

| Symbol              | Design commitment                | Current state   |
| ------------------- | -------------------------------- | --------------- |
| `GoogleOneTap`      | One-tap sign-in embed            | Not implemented |
| `Waitlist`          | Waitlist sign-up gate            | Not implemented |
| Billing components  | Usage and plan management embeds | Not implemented |
| `useReverification` | Step-up authentication hook      | Not implemented |

## i18n and appearance

All user-visible strings use Lingui runtime descriptors. Appearance is configured on the UI
component being rendered, not on `XidProvider`:

```tsx
<SignIn
  appearance={{
    variables: { colorPrimary: '#0f172a', borderRadius: '8px' },
  }}
/>
```

## Security boundaries

- React SDK does not perform protocol signing or token verification.
- Hosted Auth is the protocol entry point for sign-in, consent, and enterprise SSO flows.
- All user-visible strings use Lingui to support locale-specific display.

Status: current package.
