# @xid-kit/solid

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

SolidJS integration for [XID](https://xid.dev) - a multi-tenant identity platform.

Wraps `@xid-kit/core` to expose SolidJS-native primitives: a context provider,
reactive signal accessors (`createAuth` / `createUser` / `createOrganization` /
`createSession`), and headless components (`SignInButton` / `SignOutButton` / `Protect`).

## Install

```
pnpm add solid-js @xid-kit/solid
```

## Peer dependencies

| Package  | Version |
| -------- | ------- |
| solid-js | ^1.8    |

## Usage

### 1. Wrap your app with XidProvider

```tsx
import { XidProvider } from '@xid-kit/solid'

export function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://auth.example.com"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
      <Routes />
    </XidProvider>
  )
}
```

`XidProvider` creates an `XidClient`, calls `client.load()` on mount to fetch
the current session, and tears down cleanly via `onCleanup`.

### 2. Read auth state with primitives

```tsx
import { createAuth, createUser, createOrganization } from '@xid-kit/solid'
import { Show } from 'solid-js'

function Profile() {
  const auth = createAuth()

  return (
    <Show when={auth.isLoaded()} fallback={<p>Loading...</p>}>
      <Show when={auth.isSignedIn()} fallback={<p>Not signed in</p>}>
        <p>Signed in as {auth.userId()}</p>
        <button onClick={() => void auth.signOut()}>Sign out</button>
      </Show>
    </Show>
  )
}
```

Each primitive returns reactive `Accessor<T>` (getter functions) -- call them in
JSX or `createEffect` to track changes.

### createAuth

```ts
const auth = createAuth()

auth.isLoaded() // Accessor<boolean> -- false until client.load() completes
auth.isSignedIn() // Accessor<boolean>
auth.userId() // Accessor<string | null>
auth.sessionId() // Accessor<string | null>
auth.session() // Accessor<XidSession | null>
auth.getToken() // () => Promise<Result<string, XidError>> -- short-lived JWT
auth.signOut() // (options?) => Promise<Result<null, XidError>>
```

### createUser

```ts
import { createUser } from '@xid-kit/solid'
import { Show } from 'solid-js'

function Avatar() {
  const user = createUser()

  return (
    <Show when={user().isSignedIn}>
      <img src={user().user.imageUrl ?? ''} alt="" />
    </Show>
  )
}
```

Returns `Accessor<CreateUserReturn>` where `CreateUserReturn` is a discriminated
union on `{ isLoaded, isSignedIn, user }`.

### createOrganization

```ts
const org = createOrganization()

// org() is CreateOrganizationReturn
if (org().isSignedIn) {
  console.log(org().organization?.name)
  console.log(org().membership?.role)
  await org().setActive('org_new_id') // switch active org
}
```

### createSession

```ts
const session = createSession()

if (session().isSignedIn) {
  const { value: token } = await session().getToken()
  // use token for backend requests
}
```

### 3. Headless components

#### SignInButton

```tsx
import { SignInButton } from '@xid-kit/solid'

// OIDC mode starts /authorize; same-origin mode navigates to signInUrl.
;<SignInButton signInUrl="/sign-in" redirectUrl="/dashboard">
  Log in
</SignInButton>
```

#### SignOutButton

```tsx
import { SignOutButton } from '@xid-kit/solid'

// Signs out all sessions by default; pass sessionId to target one.
;<SignOutButton redirectUrl="/home">Log out</SignOutButton>
```

#### Protect

```tsx
import { Protect } from '@xid-kit/solid'

// Requires sign-in.
<Protect fallback={<p>Access denied</p>}>
  <AdminPanel />
</Protect>

// Requires a specific role.
<Protect role="admin" fallback={<p>Admins only</p>}>
  <Settings />
</Protect>

// Requires a specific permission.
<Protect permission="org:member:write" fallback={null}>
  <InviteForm />
</Protect>
```

### 4. Token for backend verification

```ts
const auth = createAuth()

async function fetchData() {
  const result = await auth.getToken()
  if (!result.ok) return
  const res = await fetch('/api/data', {
    headers: { Authorization: `Bearer ${result.value}` },
  })
  return res.json()
}
```

Pass the token to `@xid-kit/backend`'s `verifyToken` or `authenticateRequest`
for networkless edge verification.

## Token storage

Tokens are managed by `@xid-kit/core`. The XID Worker stores an opaque refresh credential in an
`HttpOnly` cookie; that cookie is not a JWT and the SDK never reads it from JavaScript.
`getToken()` exchanges the cookie through `/v1/sessions/token` and keeps the returned short-lived
JWT only in `TokenManager` memory. No secrets are stored in `localStorage` or in this package.

## Self-hosted deployment

```tsx
<XidProvider
  mode="oidc"
  issuer="https://auth.yourdomain.com"
  clientId="client_abc123"
  redirectUri="https://app.yourdomain.com/auth/callback"
>
  <App />
</XidProvider>
```

If the application deliberately serves Core authentication routes on its exact origin, use
`<XidProvider mode="same-origin">` instead. Do not point same-origin mode at a different origin.
