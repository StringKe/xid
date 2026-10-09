# @xid-kit/core

XID publishes no packages to npm; `@xid-kit/core` is distributed as source in the XID repository.

Browser core SDK for XID.

Status: current package.

Responsibilities:

- Run the browser OIDC Authorization Code + PKCE S256 flow for cross-origin applications.
- Load and cache `/v1/me` client state for exact same-origin Core deployments.
- Manage session state for framework bindings.
- Return short-lived access tokens through `getToken()`.
- Expose Management API helpers used by embedded UI.
- Switch active organization through the explicit session API.

Cross-origin application:

```ts
import { XidClient } from '@xid-kit/core'

const xid = new XidClient({
  mode: 'oidc',
  issuer: 'https://auth.example.com',
  clientId: 'client_abc123',
  redirectUri: 'https://app.example.com/auth/callback',
})

const authorization = await xid.createAuthorizationUrl({ returnUrl: '/dashboard' })
if (authorization.ok) window.location.assign(authorization.value)
```

Use `{ mode: 'same-origin' }` only when Core auth routes and its `HttpOnly` cookie are served on the
application's exact origin, either directly or through an intentional reverse route.

Guest onboarding is also same-origin. The endpoint owns the next route, so applications follow the
typed result instead of hardcoding `/create-organization`:

```ts
const guest = await xid.signInAnonymously()
if (guest.ok && guest.value.nextStep === 'redirect') {
  window.location.assign(guest.value.redirectUrl)
}
```

`guest.value.state` is the refreshed `XidState`. For compatibility with the earlier alpha contract,
the same state fields remain available directly on `guest.value`; migrate new code to `.state`.
When an existing signed-in session is reused, `nextStep` is `complete` and `redirectUrl` is `null`.

Convert the guest in place with a passkey (same-origin mode only, no Hosted Auth redirect):

```ts
const upgraded = await xid.upgradeGuestWithPasskey()
if (!upgraded.ok && upgraded.error.code === 'access_denied') {
  // The user cancelled the authenticator prompt; they remain a guest.
}
```

In OIDC mode an expired access session reauthorizes through `signInSilent()` (best-effort
hidden-iframe `prompt=none`) with `signInSilentWithRedirect()` as the reliable top-level redirect
fallback; `login_required` / `consent_required` / `interaction_required` in `error.code` means
interactive sign-in is required.

Security:

- Does not store a client secret.
- Does not expose refresh token material to browser code.
- The browser OIDC baseline does not request `offline_access`; an expired OIDC session must
  reauthorize.
- Same-origin mode rejects an absolute `apiUrl` on a different origin.

## Install

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/core": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack its dependency closure:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/core... build
for pkg in types crypto protocol core; do
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
    "@xid-kit/core": "file:vendor/xid/xid-kit-core-0.1.0-alpha.0.tgz"
  }
}
```

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.

See `docs/sdks/web.md` and `docs/sdks/platform-matrix.md`.
