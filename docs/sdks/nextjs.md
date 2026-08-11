# Next.js SDK

`@xid-kit/nextjs` provides Next.js middleware, App Router and Pages Router server helpers, and re-exports all `@xid-kit/react` client components and selected `@xid-kit/backend` utilities for use in a single package.

## Install

Registry status is `UNPUBLISHED`: local release artifacts are verified, but no npm publication has
been performed or authorized. The registry command below is post-publication only and becomes valid
after an independently verified authorized release. Until then, install from a source checkout or
audited tarball as described in [SDK Distribution](./distribution.md).

```sh
# Post-publication only
pnpm add @xid-kit/nextjs
```

## Quickstart: middleware

```ts
// middleware.ts
import { xidMiddleware } from '@xid-kit/nextjs'

export default xidMiddleware({
  jwtKey: JSON.parse(process.env.XID_JWKS_PUBLIC_KEY!),
  issuer: 'https://xid.dev',
  // This exact-origin path must be routed to XID Core.
  sessionTokenExchange: { endpoint: '/v1/sessions/token' },
})

export const config = {
  matcher: ['/dashboard(.*)', '/api/protected(.*)'],
}
```

This quickstart assumes the application and Core session-token route share an origin. Core's
`__Host-xid.rt.*` cookie is an opaque refresh credential. Middleware forwards it to
`POST /v1/sessions/token` on that same origin and verifies only the returned short-lived JWT.

If the application is on another origin, hand a short-lived JWT to the server as
`Authorization: Bearer <token>`, or use an application-owned JWT cookie with `jwtCookieName`. Never
copy a Core refresh cookie to the application origin.

## Quickstart: App Router

```tsx
// app/dashboard/page.tsx
import { auth, currentUser } from '@xid-kit/nextjs'

export default async function DashboardPage() {
  const { userId } = await auth()
  if (!userId) return null
  const user = await currentUser()
  return <p>Welcome {user?.email}</p>
}
```

## Quickstart: Pages Router

```ts
// pages/dashboard.tsx
import { getAuth } from '@xid-kit/nextjs'

export const getServerSideProps = async (ctx) => {
  const { userId } = await getAuth(ctx.req)
  if (!userId) return { redirect: { destination: '/sign-in', permanent: false } }
  return { props: {} }
}
```

## Exported API

### Middleware

| Export                 | Kind     | Description                                                                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `xidMiddleware`        | function | Edge Runtime middleware: verifies session JWT networklessly, injects auth state into request headers for server components and route handlers |
| `XidMiddlewareOptions` | type     | Options include jwtKey, issuer, route protection, jwtCookieName, and same-origin sessionTokenExchange                                         |

### Server helpers

| Export                   | Kind     | Description                                                                       |
| ------------------------ | -------- | --------------------------------------------------------------------------------- |
| `auth`                   | function | App Router: returns `AuthObject` with userId, orgId, orgRole from current request |
| `getAuth`                | function | Pages Router: returns `AuthObject` from `IncomingMessage`                         |
| `currentUser`            | function | App Router: fetches full user object using the server-side auth context           |
| `xidClient`              | function | Returns a server-side `XidApiClient` bound to the current request auth            |
| `XidServerClientOptions` | type     | Options for `xidClient`                                                           |

### Constants

| Export            | Kind            | Description                                                                  |
| ----------------- | --------------- | ---------------------------------------------------------------------------- |
| `XID_AUTH_HEADER` | string constant | Header name used to pass auth state between middleware and server components |

### Types

| Export                      | Description                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `AuthObject`                | Authenticated state: userId, orgId, orgRole, sessionId; orgRole is `owner`, `admin`, or `member` |
| `UnauthenticatedAuthObject` | Unauthenticated state with null fields                                                           |
| `AuthResult`                | Union of `AuthObject` and `UnauthenticatedAuthObject`                                            |
| `PaginationParams`          | Cursor and limit params for Management API list calls                                            |
| `PaginatedResponse<T>`      | Paginated response envelope                                                                      |

### Re-exports from @xid-kit/react

All exports from `@xid-kit/react` are re-exported. See the [React SDK](./react.md) for the full list: `XidProvider`, all hooks (`useAuth`, `useUser`, `useSession`, etc.), all control components (`SignedIn`, `SignedOut`, `Protect`, etc.), and all UI components (`SignIn`, `SignUp`, `UserButton`, etc.).

### Re-exports from @xid-kit/backend

| Export                       | Description                          |
| ---------------------------- | ------------------------------------ |
| `verifyToken`                | Low-level access token verification  |
| `verifyWebhook`              | Webhook signature validation         |
| `authenticateRequest`        | Full request authentication          |
| `JwksCache`                  | Optional network-fetching JWKS cache |
| `toVerifyKeySet`             | Convert JwtKey to VerifyKeySet       |
| `AppError`                   | SDK error class                      |
| `BACKEND_ERROR_CODES`        | All backend error code values        |
| `VerifyTokenOptions`         | Type                                 |
| `VerifyTokenError`           | Type                                 |
| `AuthenticateRequestOptions` | Type                                 |
| `RequestState`               | Type                                 |
| `SignedInState`              | Type                                 |
| `SignedOutState`             | Type                                 |
| `VerifyWebhookOptions`       | Type                                 |
| `WebhookVerifyError`         | Type                                 |
| `VerifiedWebhook`            | Type                                 |
| `JwtKey`                     | Type                                 |
| `JwksCacheOptions`           | Type                                 |
| `BackendErrorCode`           | Type                                 |

## Security boundaries

- Middleware runs on the Edge Runtime and reads only the session JWT; it does not expose secrets to client bundles.
- Core opaque refresh cookies are validated only by Core through an exact same-origin exchange.
- Server helpers do not pass signing secrets to client components.
- Token verification is delegated to `@xid-kit/backend`.

Status: current package.
