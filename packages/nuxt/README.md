# @xid-kit/nuxt

Nuxt 3 integration for the XID identity platform. Provides a Nuxt module, server middleware
(H3/Nitro), and auto-imported composables backed by `@xid-kit/vue`.

---

## Installation

```bash
pnpm add @xid-kit/nuxt
```

Nuxt 3 (`>=3.0.0`) and Vue 3 (`>=3.3.0`) are peer dependencies.

---

## Quick Start

### 1. Register the Module

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@xid-kit/nuxt'],

  runtimeConfig: {
    public: {
      // omit for same-origin deployment
      xidApiUrl: '',
    },
  },
})
```

The module:

- Auto-registers a client-only plugin that installs `XidPlugin` into the Vue app
- Auto-imports `useXid / useAuth / useUser / useOrganization / useSession` composables

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

### Server Middleware

| Export                               | Description                                    |
| ------------------------------------ | ---------------------------------------------- |
| `createXidServerMiddleware(options)` | H3 event handler factory                       |
| `getXidAuth(event)`                  | Read `AuthResult` from `event.context.xidAuth` |
| `XID_AUTH_CONTEXT_KEY`               | Context key string (`'xidAuth'`)               |

#### `XidServerMiddlewareOptions`

| Field                | Type                                         | Description                                                  |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `jwtKey`             | `JwtKey`                                     | JWKS public key(s) for networkless JWT verification          |
| `issuer?`            | `string`                                     | Expected issuer (multi-tenant)                               |
| `authorizedParties?` | `readonly string[]`                          | azp whitelist                                                |
| `cookieName?`        | `string`                                     | Session cookie name, default `__session`                     |
| `protectedRoutes?`   | `readonly string[]`                          | Route prefixes requiring auth (returns 401 if not signed in) |
| `onUnauthenticated?` | `(event) => { statusCode, message } \| null` | Custom auth failure handler                                  |

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
- For production, ensure the server middleware is registered as a global Nitro middleware
  (file placed in `server/middleware/`) so it covers all routes.
