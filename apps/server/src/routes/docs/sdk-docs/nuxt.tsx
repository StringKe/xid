// @xid-kit/nuxt 参考页。API 真相源:packages/nuxt/src/index.ts 与 server-middleware.ts。

import { Trans } from '@lingui/react/macro'
import { Link } from '../../../lib/router'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. The Nuxt module, H3/Nitro server
        middleware, and auto-imported composables are implemented. A real IdP round-trip on
        production infrastructure is still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Module setup</Trans>,
    body: [
      <Trans>
        Add <code>@xid-kit/nuxt</code> to the <code>modules</code> array. The module auto-imports
        all <Link to="/docs/sdks/vue">@xid-kit/vue</Link> composables and registers a client-only
        plugin that installs <code>XidPlugin</code>.
      </Trans>,
    ],
    code: `// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@xid-kit/nuxt'],

  runtimeConfig: {
    public: {
      xidApiUrl: '', // optional: omit for same-origin deployment
    },
  },
})`,
  },
  {
    heading: <Trans>Composables (auto-imported)</Trans>,
    code: `<script setup lang="ts">
// No import needed — Nuxt auto-imports from @xid-kit/vue
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
</template>`,
  },
  {
    heading: <Trans>Server middleware (JWT auth)</Trans>,
    body: [
      <Trans>
        <code>createXidServerMiddleware</code> returns an H3 event handler that verifies the JWT
        networklessly and writes <code>event.context.xidAuth</code>. Place the file in{' '}
        <code>server/middleware/</code> so Nitro registers it as a global middleware.
      </Trans>,
    ],
    code: `// server/middleware/xid.ts
import { createXidServerMiddleware } from '@xid-kit/nuxt'

export default createXidServerMiddleware({
  jwtKey: JSON.parse(process.env.XID_JWKS_PUBLIC_KEY!),
  issuer: 'https://acme.xid.dev',
  protectedRoutes: ['/api/admin'],
})`,
  },
  {
    heading: <Trans>Reading auth in server routes</Trans>,
    code: `// server/routes/api/me.get.ts
import { getXidAuth } from '@xid-kit/nuxt'

export default defineEventHandler((event) => {
  const auth = getXidAuth(event)
  if (!auth.userId) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  return { userId: auth.userId, orgId: auth.orgId }
})`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">createXidServerMiddleware</code>,
          <Trans>function</Trans>,
          <Trans>
            H3 event handler factory: verifies JWT, writes event.context.xidAuth, protects routes
          </Trans>,
        ],
        [
          <code key="e">getXidAuth</code>,
          <Trans>function</Trans>,
          <Trans>Read AuthResult from event.context.xidAuth in server routes and handlers</Trans>,
        ],
        [
          <code key="e">XID_AUTH_CONTEXT_KEY</code>,
          <Trans>string constant</Trans>,
          <Trans>Context key used to store auth result ('xidAuth')</Trans>,
        ],
        [
          <code key="e">XidServerMiddlewareOptions</code>,
          <Trans>type</Trans>,
          <Trans>
            jwtKey, issuer, authorizedParties, cookieName, protectedRoutes, onUnauthenticated
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Security notes</Trans>,
    bullets: [
      <Trans>
        <code>event.context.xidAuth</code> is server-side only and is never sent to the browser.
      </Trans>,
      <Trans>
        The middleware strips any client-supplied auth tokens and re-injects only the verified
        result.
      </Trans>,
      <Trans>
        Place the middleware file in <code>server/middleware/</code> to ensure it covers all routes
        as a global Nitro middleware.
      </Trans>,
    ],
  },
]

export const NUXT_DOC = defineSdkDoc({
  slug: 'sdks/nuxt',
  packageName: '@xid-kit/nuxt',
  summary: (
    <Trans>
      Nuxt 3 module with H3/Nitro server middleware and auto-imported Vue composables for SSR and
      full-stack apps.
    </Trans>
  ),
  sections,
})
