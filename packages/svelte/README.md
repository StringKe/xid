# @xid-kit/svelte

Svelte 5 / SvelteKit binding for the XID identity platform.

Peer dependencies: `svelte >= 5.0.0` (required), `@sveltejs/kit >= 2.0.0` (optional, for server hooks), `@xid-kit/backend` (optional, for server hooks).

## Quick start

Install in your SvelteKit project:

```bash
pnpm add @xid-kit/svelte svelte
pnpm add -D @sveltejs/kit
# for server-side auth:
pnpm add @xid-kit/backend
```

## Client-side setup

### 1. Create stores in root layout (+layout.svelte)

```svelte
<script lang="ts">
  import { setContext, onMount } from 'svelte'
  import { XidClient, createXidStores, setXidContext } from '@xid-kit/svelte'

  const client = new XidClient({ apiUrl: 'https://acme.xid.dev' })
  const stores = createXidStores(client)
  setXidContext(setContext, stores)

  onMount(() => {
    const ac = new AbortController()
    void client.load({ signal: ac.signal })
    return () => ac.abort()
  })
</script>

<slot />
```

### 2. Access state in a child component

```svelte
<script lang="ts">
  import { getContext } from 'svelte'
  import { getXidContext } from '@xid-kit/svelte'

  const { auth, user } = getXidContext(getContext)

  // $auth is reactive: { isLoaded, isSignedIn, userId, sessionId, session }
  // $user is reactive: one of three discriminated union shapes
</script>

{#if !$auth.isLoaded}
  <p>Loading...</p>
{:else if $auth.isSignedIn}
  <p>Hello, {$user.isSignedIn ? $user.user.fullName : ''}</p>
{:else}
  <p>Not signed in</p>
{/if}
```

### 3. Sign in and sign out

```svelte
<script lang="ts">
  import { getContext } from 'svelte'
  import { getXidContext, buildSignInUrl, executeSignOut } from '@xid-kit/svelte'

  const { client } = getXidContext(getContext)

  function handleSignIn() {
    window.location.assign(buildSignInUrl('/sign-in', window.location.href))
  }

  async function handleSignOut() {
    await executeSignOut(client, { redirectUrl: '/' })
  }
</script>

<button onclick={handleSignIn}>Sign in</button>
<button onclick={handleSignOut}>Sign out</button>
```

### 4. Protect content by role or permission

```svelte
<script lang="ts">
  import { getContext } from 'svelte'
  import { getXidContext, isAllowed } from '@xid-kit/svelte'

  const { state } = getXidContext(getContext)
</script>

{#if isAllowed($state, { role: 'org:admin' })}
  <AdminPanel />
{/if}

{#if isAllowed($state, { permission: 'org:member:write' })}
  <EditButton />
{/if}
```

## Server-side setup (SvelteKit)

### 5. Handle hook (src/hooks.server.ts)

```typescript
import { handleXid } from '@xid-kit/svelte/server'

export const handle = handleXid({
  jwtKey: JSON.parse(process.env.XID_JWT_KEY!),
  issuer: 'https://xid.dev',
  protectedRoutes: ['/dashboard', '/account'],
  signInUrl: '/sign-in',
  publicRoutes: ['/dashboard/public'],
})
```

Multiple handle hooks via SvelteKit `sequence`:

```typescript
import { sequence } from '@sveltejs/kit/hooks'
import { handleXid } from '@xid-kit/svelte/server'

const xid = handleXid({ jwtKey: JSON.parse(process.env.XID_JWT_KEY!) })
export const handle = sequence(xid, myOtherHandle)
```

### 6. Reading auth in load functions (+page.server.ts)

```typescript
import { redirect } from '@sveltejs/kit'
import { getXidAuth } from '@xid-kit/svelte/server'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  const auth = getXidAuth(locals)
  if (!auth.userId) throw redirect(303, '/sign-in')

  return { userId: auth.userId, orgId: auth.orgId }
}
```

## App Locals typing (src/app.d.ts)

Add to your SvelteKit app type declarations:

```typescript
import type { AuthResult } from '@xid-kit/svelte/server'

declare global {
  namespace App {
    interface Locals {
      xidAuth: AuthResult
    }
  }
}
export {}
```

## Store shapes

### auth store (`AuthState`)

```typescript
{
  isLoaded: boolean
  isSignedIn: boolean
  userId: string | null
  sessionId: string | null
  session: XidSession | null
}
```

### user store (`UserState`)

Discriminated union:

```typescript
| { isLoaded: false; isSignedIn: false; user: null }
| { isLoaded: true; isSignedIn: false; user: null }
| { isLoaded: true; isSignedIn: true; user: XidUser }
```

### organization store (`OrganizationState`)

```typescript
| { isLoaded: false; isSignedIn: false; organization: null; membership: null }
| { isLoaded: true; isSignedIn: false; organization: null; membership: null }
| { isLoaded: true; isSignedIn: true; organization: XidOrganization | null; membership: XidOrganizationMembership | null }
```

### session store (`SessionState`)

```typescript
| { isLoaded: false; isSignedIn: false; session: null }
| { isLoaded: true; isSignedIn: false; session: null }
| { isLoaded: true; isSignedIn: true; session: XidSession }
```

## SDK architecture

```
@xid-kit/core          Framework-agnostic state + token management
@xid-kit/svelte        Svelte / SvelteKit reactive bindings (this package)
@xid-kit/backend       Server-side JWT verification (used by handleXid)
```

`XidClient.subscribe` satisfies the Svelte store subscriber contract:
it accepts a listener and returns an unsubscribe function. `createXidStores`
wraps this into typed derived stores for each auth dimension.
