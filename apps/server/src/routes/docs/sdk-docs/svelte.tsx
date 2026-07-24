// @xid-kit/svelte 参考页。API 真相源:packages/svelte/src/index.ts 与 server.ts。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. Svelte 5 stores, SvelteKit server hook,
        and helper utilities are implemented. A real IdP round-trip on production infrastructure is
        still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Client setup</Trans>,
    body: [
      <Trans>
        Create stores in the root layout using <code>createXidStores</code> and{' '}
        <code>setXidContext</code>. Stores use <code>XidClient.subscribe</code>, which satisfies the
        Svelte store subscriber contract.
      </Trans>,
    ],
    code: `<!-- +layout.svelte -->
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
<slot />`,
  },
  {
    heading: <Trans>Reading auth state</Trans>,
    code: `<!-- Any child component -->
<script lang="ts">
  import { getContext } from 'svelte'
  import { getXidContext } from '@xid-kit/svelte'

  const { auth, user } = getXidContext(getContext)
  // $auth: { isLoaded, isSignedIn, userId, sessionId, session }
  // $user: discriminated union on isLoaded / isSignedIn / user
</script>

{#if !$auth.isLoaded}
  <p>Loading...</p>
{:else if $auth.isSignedIn}
  <p>Hello, {$user.isSignedIn ? $user.user.fullName : ''}</p>
{:else}
  <p>Not signed in</p>
{/if}`,
  },
  {
    heading: <Trans>Sign-in and sign-out</Trans>,
    code: `<script lang="ts">
  import { getContext } from 'svelte'
  import { getXidContext, buildSignInUrl, executeSignOut } from '@xid-kit/svelte'

  const { client } = getXidContext(getContext)

  function handleSignIn() {
    window.location.assign(buildSignInUrl('/sign-in', window.location.href))
  }

  async function handleSignOut() {
    await executeSignOut(client, { redirectUrl: '/' })
  }
</script>`,
  },
  {
    heading: <Trans>Role and permission guard</Trans>,
    code: `<script lang="ts">
  import { getContext } from 'svelte'
  import { getXidContext, isAllowed } from '@xid-kit/svelte'

  const { state } = getXidContext(getContext)
</script>

{#if isAllowed($state, { role: 'org:admin' })}
  <AdminPanel />
{/if}

{#if isAllowed($state, { permission: 'org:member:write' })}
  <EditButton />
{/if}`,
  },
  {
    heading: <Trans>SvelteKit server hook</Trans>,
    code: `// src/hooks.server.ts
import { handleXid } from '@xid-kit/svelte/server'

export const handle = handleXid({
  jwtKey: JSON.parse(process.env.XID_JWT_KEY!),
  issuer: 'https://xid.dev',
  protectedRoutes: ['/dashboard', '/account'],
  signInUrl: '/sign-in',
})`,
  },
  {
    heading: <Trans>Reading auth in load functions</Trans>,
    code: `// +page.server.ts
import { redirect } from '@sveltejs/kit'
import { getXidAuth } from '@xid-kit/svelte/server'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  const auth = getXidAuth(locals)
  if (!auth.userId) throw redirect(303, '/sign-in')
  return { userId: auth.userId, orgId: auth.orgId }
}`,
  },
  {
    heading: <Trans>App.Locals typing</Trans>,
    code: `// src/app.d.ts
import type { AuthResult } from '@xid-kit/svelte/server'

declare global {
  namespace App {
    interface Locals {
      xidAuth: AuthResult
    }
  }
}
export {}`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Module</Trans>],
      rows: [
        [
          <code key="e">XidClient, createXidStores, setXidContext, getXidContext</code>,
          <Trans>client setup</Trans>,
          <code key="m">@xid-kit/svelte</code>,
        ],
        [
          <code key="e">buildSignInUrl, executeSignOut, isAllowed</code>,
          <Trans>utilities</Trans>,
          <code key="m">@xid-kit/svelte</code>,
        ],
        [
          <code key="e">handleXid, getXidAuth</code>,
          <Trans>server hook</Trans>,
          <code key="m">@xid-kit/svelte/server</code>,
        ],
      ],
    },
  },
]

export const SVELTE_DOC = defineSdkDoc({
  slug: 'sdks/svelte',
  packageName: '@xid-kit/svelte',
  summary: (
    <Trans>
      Svelte 5 reactive stores and SvelteKit server hook for client and SSR authentication.
    </Trans>
  ),
  sections,
})
