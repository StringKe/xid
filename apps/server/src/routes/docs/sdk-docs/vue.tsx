// @xid-kit/vue 参考页。API 真相源:packages/vue/src/index.ts。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. Vue 3 plugin, composables, and headless
        components are implemented. A real IdP round-trip on production infrastructure is still
        pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Plugin setup</Trans>,
    body: [
      <Trans>
        Register <code>XidPlugin</code> once in <code>main.ts</code>. It creates an{' '}
        <code>XidClient</code> singleton, provides it via <code>XID_INJECTION_KEY</code>, and calls{' '}
        <code>client.load()</code> to hydrate session state.
      </Trans>,
    ],
    code: `// main.ts
import { createApp } from 'vue'
import { XidPlugin } from '@xid-kit/vue'
import App from './App.vue'

const app = createApp(App)
app.use(XidPlugin, { apiUrl: 'https://your-tenant.xid.dev' })
app.mount('#app')`,
  },
  {
    heading: <Trans>Composables</Trans>,
    code: `import { useAuth, useUser, useOrganization, useSession } from '@xid-kit/vue'

const auth = useAuth()
// auth.isLoaded / auth.isSignedIn / auth.userId
// auth.getToken()  -> Promise<Result<string, XidError>>
// auth.signOut()   -> Promise<Result<null, XidError>>

const userRef = useUser()
// userRef.value.isLoaded && userRef.value.isSignedIn -> userRef.value.user.id

const orgRef = useOrganization()
// orgRef.value.organization / orgRef.value.membership / orgRef.value.setActive()

const sessionRef = useSession()
// sessionRef.value.session / sessionRef.value.getToken()`,
  },
  {
    heading: <Trans>Components</Trans>,
    code: `<template>
  <SignInButton sign-in-url="/sign-in" redirect-url="/dashboard">Log in</SignInButton>
  <SignOutButton redirect-url="/">Log out</SignOutButton>

  <Protect role="org:admin">
    <AdminPanel />
    <template #fallback><p>Access denied.</p></template>
  </Protect>

  <Protect permission="org:member:read">
    <MemberList />
  </Protect>
</template>

<script setup lang="ts">
import { SignInButton, SignOutButton, Protect } from '@xid-kit/vue'
</script>`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">XidPlugin</code>,
          <Trans>Vue plugin</Trans>,
          <Trans>app.use entry point; registers XidClient and calls client.load()</Trans>,
        ],
        [
          <code key="e">createXidClient</code>,
          <Trans>function</Trans>,
          <Trans>Factory that returns a standalone XidClient instance</Trans>,
        ],
        [
          <code key="e">useXidClient</code>,
          <Trans>composable</Trans>,
          <Trans>Returns the injected XidClient; throws if plugin is not registered</Trans>,
        ],
        [
          <code key="e">XID_INJECTION_KEY</code>,
          <Trans>InjectionKey</Trans>,
          <Trans>Symbol used to provide and inject the XidClient singleton</Trans>,
        ],
        [
          <code key="e">useXid</code>,
          <Trans>composable</Trans>,
          <Trans>Full state ref plus all client actions (UseXidReturn)</Trans>,
        ],
        [
          <code key="e">useAuth</code>,
          <Trans>composable</Trans>,
          <Trans>isLoaded, isSignedIn, userId, getToken, signOut</Trans>,
        ],
        [
          <code key="e">useUser</code>,
          <Trans>composable</Trans>,
          <Trans>Ref wrapping discriminated union on isLoaded / isSignedIn / user</Trans>,
        ],
        [
          <code key="e">useOrganization</code>,
          <Trans>composable</Trans>,
          <Trans>Active org, membership, and setActive action</Trans>,
        ],
        [
          <code key="e">useSession</code>,
          <Trans>composable</Trans>,
          <Trans>Active session and getToken action</Trans>,
        ],
        [
          <code key="e">SignInButton</code>,
          <Trans>component</Trans>,
          <Trans>Headless button that redirects to the sign-in URL on click</Trans>,
        ],
        [
          <code key="e">SignOutButton</code>,
          <Trans>component</Trans>,
          <Trans>Headless button that calls client.signOut() on click</Trans>,
        ],
        [
          <code key="e">Protect</code>,
          <Trans>component</Trans>,
          <Trans>Slot-based role and permission gate with default and fallback slots</Trans>,
        ],
      ],
    },
  },
]

export const VUE_DOC = defineSdkDoc({
  slug: 'sdks/vue',
  packageName: '@xid-kit/vue',
  summary: (
    <Trans>Vue 3 plugin, composables, and headless components on top of @xid-kit/core.</Trans>
  ),
  sections,
})
