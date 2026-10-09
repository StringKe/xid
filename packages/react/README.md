# @xid-kit/react

XID publishes no packages to npm; `@xid-kit/react` is distributed as source in the XID repository.

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

## Install

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/react": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack its dependency closure:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/react... build
for pkg in types crypto protocol core react; do
  pnpm --dir "packages/$pkg" pack --pack-destination /path/to/your-app/vendor/xid
done
```

Reference every tarball from the application's `package.json`:

```json
{
  "dependencies": {
    "@xid-kit/types": "file:vendor/xid/xid-kit-types-0.1.0-alpha.0.tgz",
    "@xid-kit/crypto": "file:vendor/xid/xid-kit-crypto-0.1.0-alpha.0.tgz",
    "@xid-kit/protocol": "file:vendor/xid/xid-kit-protocol-0.1.0-alpha.0.tgz",
    "@xid-kit/core": "file:vendor/xid/xid-kit-core-0.1.0-alpha.0.tgz",
    "@xid-kit/react": "file:vendor/xid/xid-kit-react-0.1.0-alpha.0.tgz"
  }
}
```

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.

See `docs/sdks/react.md` and `docs/sdks/platform-matrix.md`.
