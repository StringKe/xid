# @xid-kit/react

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

React SDK for XID.

Status: current package.

Responsibilities:

- `XidProvider` context.
- Authentication, session, user, organization, and API key hooks.
- Control components such as `SignedIn`, `SignedOut`, and `Protect`.
- Hosted Auth UI entry components and organization UI components.

Quick start for an application whose origin differs from its XID issuer:

```tsx
import { SignInButton, SignedIn, SignedOut, XidProvider } from '@xid-kit/react'

export function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://auth.example.com"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
      <SignedOut>
        <SignInButton>Sign in</SignInButton>
      </SignedOut>
      <SignedIn>Signed in</SignedIn>
    </XidProvider>
  )
}
```

Use `<XidProvider mode="same-origin">` only when the application origin serves or reverse-routes
Core authentication endpoints. Component styling is configured on the individual Hosted Auth
component through its `appearance` prop, not on `XidProvider`.

In same-origin mode, `useSignIn()` exposes the same server-owned guest onboarding result:

```tsx
const { signInAnonymously } = useSignIn()

async function continueAsGuest() {
  const guest = await signInAnonymously()
  if (guest.ok && guest.value.nextStep === 'redirect') {
    window.location.assign(guest.value.redirectUrl)
  }
}
```

No guest onboarding route or publishable key is configured in React. Core returns the refreshed
state at `guest.value.state`; the flattened state fields remain temporarily compatible with the
earlier alpha return type.

`useUpgradeGuest()` converts a guest in place with one click (same-origin mode only):

```tsx
const { isGuest, pending, error, upgradeGuestWithPasskey } = useUpgradeGuest()
```

Security:

- Does not perform protocol signing.
- Delegates login and consent to Hosted Auth.
- Uses the registered OAuth `clientId`; there is no separate publishable-key contract.
- Uses Lingui runtime descriptors for user-visible text.

See `docs/sdks/react.md` and `docs/sdks/platform-matrix.md`.
