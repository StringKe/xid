# @xid-kit/core

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

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

Security:

- Does not store a client secret.
- Does not expose refresh token material to browser code.
- The browser OIDC baseline does not request `offline_access`; an expired OIDC session must
  reauthorize.
- Same-origin mode rejects an absolute `apiUrl` on a different origin.

See `docs/sdks/web.md` and `docs/sdks/platform-matrix.md`.
