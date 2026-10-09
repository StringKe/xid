# @xid-kit/nuxt

XID publishes no packages to npm; `@xid-kit/nuxt` is distributed as source in the XID repository.

Nuxt 3 integration for the XID identity platform. Provides a Nuxt module, server middleware
(H3/Nitro), and auto-imported composables backed by `@xid-kit/vue`.

---

## Installation

Inside the XID repository, reference the workspace package:

```json
{
  "dependencies": {
    "@xid-kit/nuxt": "workspace:^"
  }
}
```

In another repository, build the package from a pinned XID commit and pack its dependency closure:

```bash
git clone https://github.com/StringKe/xid.git
cd xid
git checkout <commit>
pnpm install --frozen-lockfile
pnpm --filter @xid-kit/nuxt... build
for pkg in types crypto protocol core backend vue nuxt; do
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
    "@xid-kit/backend": "file:vendor/xid/xid-kit-backend-0.1.0-alpha.0.tgz",
    "@xid-kit/vue": "file:vendor/xid/xid-kit-vue-0.1.0-alpha.0.tgz",
    "@xid-kit/nuxt": "file:vendor/xid/xid-kit-nuxt-0.1.0-alpha.0.tgz"
  }
}
```

Nuxt 3 (`>=3.0.0`) and Vue 3 (`>=3.3.0`) are peer dependencies.

See the [SDK distribution guide](../../docs/sdks/distribution.md) for details.

---

## Quick Start

### 1. Register the Module

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@xid-kit/nuxt'],
  xid: {
    browser: {
      mode: 'oidc',
      issuer: 'https://auth.example.com',
      clientId: 'client_abc123',
      redirectUri: 'https://app.example.com/auth/callback',
    },
  },
})
```

The module:

- Auto-registers a client-only plugin that installs `XidPlugin` into the Vue app
- Auto-imports `useXid / useAuth / useUser / useOrganization / useSession` composables
- Writes only the serializable `browser` configuration to public runtime config

Use `xid: { browser: { mode: 'same-origin' } }` only when Core authentication routes are served on
the Nuxt application's exact origin. The legacy `apiUrl` option is also same-origin only and cannot
be combined with `browser`.

### 2. Composables (auto-imported)

```vue
<script setup lang="ts">
// No import needed -- Nuxt auto-imports these from @xid-kit/vue
const auth = useAuth()
const userRef = useUser()
const orgRef = useOrganization()
const sessionRef = useSession()
</script>

<template>
  <div v-if="auth.isSignedIn">
    Signed in as {{ auth.userId }}
    <button @click="auth.signOut()">Sign out</button>
  </div>
</template>
```

### 3. Server Middleware (JWT authentication)

```ts
// server/middleware/xid.ts
import { createXidServerMiddleware } from '@xid-kit/nuxt'

export default createXidServerMiddleware({
  // jwtKey: PublicJwk | PublicJwk[] -- JWKS public key(s) for networkless verification
  jwtKey: JSON.parse(process.env.XID_JWKS_PUBLIC_KEY!),
  issuer: 'https://acme.xid.dev',
  // Required for Core browser sessions when this path is routed to Core on the same origin.
  sessionTokenExchange: { endpoint: '/v1/sessions/token' },
  // Required on H3 v1 Node/Nitro when req.url is relative.
  requestOrigin: process.env.XID_APP_ORIGIN!,
  // Optional: protect server API routes (returns 401 if unauthenticated)
  protectedRoutes: ['/api/admin'],
})
```

The middleware injects `event.context.xidAuth` into every H3 event context.

### 4. Read Auth in Server Routes

```ts
// server/routes/api/me.get.ts
import { getXidAuth } from '@xid-kit/nuxt'

export default defineEventHandler((event) => {
  const auth = getXidAuth(event)
  if (!auth.userId) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  return { userId: auth.userId, orgId: auth.orgId }
})
```

---

## API Reference

### Module

| Export              | Description                                      |
| ------------------- | ------------------------------------------------ |
| `defineXidModule()` | Nuxt module factory (used by Nuxt module system) |
| `moduleMetadata`    | Module name/configKey/compatibility metadata     |

`XidNuxtModuleOptions.browser` accepts the serializable Core OIDC/same-origin union. Runtime-only
hooks such as `fetcher`, `tokenCache`, `now`, and `secretKey` are intentionally unavailable in
`nuxt.config.ts`.

### Server Middleware

| Export                               | Description                                    |
| ------------------------------------ | ---------------------------------------------- |
| `createXidServerMiddleware(options)` | H3 event handler factory                       |
| `getXidAuth(event)`                  | Read `AuthResult` from `event.context.xidAuth` |
| `XID_AUTH_CONTEXT_KEY`               | Context key string (`'xidAuth'`)               |

#### `XidServerMiddlewareOptions`

| Field                   | Type                                         | Description                                                   |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `jwtKey`                | `JwtKey`                                     | JWKS public key(s) for networkless JWT verification           |
| `issuer?`               | `string`                                     | Expected issuer (multi-tenant)                                |
| `authorizedParties?`    | `readonly string[]`                          | azp whitelist                                                 |
| `jwtCookieName?`        | `string`                                     | Explicit application-owned short-lived JWT cookie             |
| `sessionTokenExchange?` | `SessionTokenExchangeOptions`                | Exact same-origin Core opaque-cookie to JWT exchange          |
| `requestOrigin?`        | `string`                                     | Trusted app origin for relative H3 v1 Node/Nitro request URLs |
| `protectedRoutes?`      | `readonly string[]`                          | Route prefixes requiring auth (returns 401 if not signed in)  |
| `onUnauthenticated?`    | `(event) => { statusCode, message } \| null` | Custom auth failure handler                                   |

### Composables (re-exported from @xid-kit/vue)

| Export              | Description                                   |
| ------------------- | --------------------------------------------- |
| `useXid()`          | Full state ref + client actions               |
| `useAuth()`         | `isLoaded/isSignedIn/userId/getToken/signOut` |
| `useUser()`         | Current user (discriminated union)            |
| `useOrganization()` | Active org + membership + `setActive`         |
| `useSession()`      | Active session + `getToken`                   |

---

## Security Notes

- `event.context.xidAuth` is server-side only; it is never sent to the browser.
- The middleware strips any client-supplied auth tokens and re-injects only the verified result.
- The middleware never verifies `__Host-xid.rt.*` locally. Same-origin Core sessions use
  `POST /v1/sessions/token`; separate origins require a Bearer/JWT handoff.
- For production, ensure the server middleware is registered as a global Nitro middleware
  (file placed in `server/middleware/`) so it covers all routes.
