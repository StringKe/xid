# @xid-kit/vue

Vue 3 SDK for the XID identity platform. Provides Plugin, composables, and prebuilt components
on top of `@xid-kit/core`.

---

## Installation

```bash
pnpm add @xid-kit/vue vue
```

Vue 3 is a peer dependency (`^3.4.0`).

---

## Quick Start

### 1. Register Plugin

```ts
// main.ts
import { createApp } from 'vue'
import { XidPlugin } from '@xid-kit/vue'
import App from './App.vue'

const app = createApp(App)
app.use(XidPlugin, {
  // omit apiUrl for same-origin deployment (default)
  apiUrl: 'https://your-tenant.xid.dev',
})
app.mount('#app')
```

The plugin:

- Creates an `XidClient` singleton
- Provides it via `inject(XID_INJECTION_KEY)` for all composables
- Calls `client.load()` to fetch the login state snapshot

### 2. Composables

```ts
import { useAuth, useUser, useOrganization, useSession } from '@xid-kit/vue'

// useAuth: top-level auth state
const auth = useAuth()
// auth.isLoaded  -- boolean
// auth.isSignedIn -- boolean
// auth.userId    -- string | null
// auth.getToken()  -- Promise<Result<string, XidError>>
// auth.signOut()   -- Promise<Result<null, XidError>>

// useUser: current user (discriminated union for TypeScript narrowing)
const userRef = useUser()
// userRef.value: UseUserReturn
// if (userRef.value.isLoaded && userRef.value.isSignedIn) {
//   console.log(userRef.value.user.id)
// }

// useOrganization: active org + membership + setActive
const orgRef = useOrganization()
// orgRef.value: UseOrganizationReturn

// useSession: active session + getToken
const sessionRef = useSession()
// sessionRef.value: UseSessionReturn
```

### 3. Prebuilt Components

```vue
<template>
  <!-- Redirect to /sign-in on click -->
  <SignInButton sign-in-url="/sign-in" redirect-url="/dashboard"> Log in </SignInButton>

  <!-- Signs out; optionally redirects -->
  <SignOutButton redirect-url="/"> Log out </SignOutButton>

  <!-- Protect by role -->
  <Protect role="org:admin">
    <AdminPanel />
    <template #fallback>
      <p>Access denied.</p>
    </template>
  </Protect>

  <!-- Protect by permission -->
  <Protect permission="org:member:read">
    <MemberList />
  </Protect>
</template>

<script setup lang="ts">
import { SignInButton, SignOutButton, Protect } from '@xid-kit/vue'
</script>
```

---

## API Reference

### Plugin

| Export                      | Description                              |
| --------------------------- | ---------------------------------------- |
| `XidPlugin`                 | Vue plugin (`app.use`)                   |
| `createXidClient(options?)` | Factory: returns `XidClient`             |
| `useXidClient()`            | Composable: returns injected `XidClient` |
| `XID_INJECTION_KEY`         | `InjectionKey<XidClient>` symbol         |

### Composables

| Export              | Returns                      | Description                                   |
| ------------------- | ---------------------------- | --------------------------------------------- |
| `useXid()`          | `UseXidReturn`               | Full state ref + client actions               |
| `useAuth()`         | `UseAuthReturn`              | `isLoaded/isSignedIn/userId/getToken/signOut` |
| `useUser()`         | `Ref<UseUserReturn>`         | Current user (discriminated union)            |
| `useOrganization()` | `Ref<UseOrganizationReturn>` | Active org + membership + `setActive`         |
| `useSession()`      | `Ref<UseSessionReturn>`      | Active session + `getToken`                   |

### Components

| Export          | Props                                               | Description                       |
| --------------- | --------------------------------------------------- | --------------------------------- |
| `SignInButton`  | `signInUrl?, redirectUrl?, ariaLabel?`              | Button redirecting to sign-in     |
| `SignOutButton` | `redirectUrl?, sessionId?, ariaLabel?`              | Button calling `client.signOut()` |
| `Protect`       | `permission?, role?` + `#default / #fallback` slots | Permission/role gate              |

---

## Shared Contract

`@xid-kit/vue` is a thin reactive wrapper over `@xid-kit/core`:

- Auth logic: `XidClient`
- State subscription: `XidStore.subscribe()` + Vue `ref`
- Token management: `TokenManager` (internal)
- API communication: `XidApiClient` (internal)
