// @xid-kit/astro 参考页。API 真相源:packages/astro/src/index.ts, integration.ts, server.ts, client.ts。

import { Trans } from '@lingui/react/macro'
import { Link } from '../../../lib/router'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. The Astro integration, SSR middleware,
        server helpers, and island client singleton are implemented. A real IdP round-trip on
        production infrastructure is still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Integration setup</Trans>,
    body: [
      <Trans>
        Register <code>xidIntegration</code> in <code>astro.config.mjs</code>. The integration
        injects the auth middleware via <code>addMiddleware</code> at order <code>pre</code> and
        provides the publishable key to client islands.
      </Trans>,
    ],
    code: `// astro.config.mjs
import { defineConfig } from 'astro/config'
import { xidIntegration } from '@xid-kit/astro'
import node from '@astrojs/node'

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    xidIntegration({
      publishableKey: import.meta.env.PUBLIC_XID_PK,
      jwtKey: import.meta.env.XID_JWT_KEY,
      protectedRoutes: ['/dashboard', '/account'],
      signInUrl: '/sign-in',
    }),
  ],
})`,
  },
  {
    heading: <Trans>Manual middleware (alternative)</Trans>,
    code: `// src/middleware.ts
import { sequence } from 'astro:middleware'
import { createXidMiddleware } from '@xid-kit/astro'

export const onRequest = sequence(
  createXidMiddleware({
    jwtKey: import.meta.env.XID_JWT_KEY,
    issuer: 'https://xid.dev',
    protectedRoutes: ['/dashboard', '/account'],
    signInUrl: '/sign-in',
  }),
)`,
  },
  {
    heading: <Trans>Server-side auth in .astro pages</Trans>,
    code: `---
// src/pages/dashboard.astro
import { getAuth, currentUser } from '@xid-kit/astro/server'

const auth = getAuth(Astro.locals)
if (!auth.userId) return Astro.redirect('/sign-in')

const user = await currentUser(Astro.locals, {
  secretKey: import.meta.env.XID_SECRET_KEY,
})
---

<h1>Welcome, {user?.primaryEmailAddress}</h1>`,
  },
  {
    heading: <Trans>Client island</Trans>,
    code: `// src/components/SignOutButton.tsx
import { getClient } from '@xid-kit/astro/client'

export default function SignOutButton() {
  const client = getClient()

  const handleSignOut = async () => {
    await client.signOut()
    window.location.href = '/'
  }

  return <button onClick={handleSignOut}>Sign out</button>
}`,
  },
  {
    heading: <Trans>Astro.locals typing</Trans>,
    body: [
      <Trans>
        Add the type reference to <code>src/env.d.ts</code> to get full type coverage on{' '}
        <code>Astro.locals.xidAuth</code>.
      </Trans>,
    ],
    code: `/// <reference path="../node_modules/@xid-kit/astro/src/locals.d.ts" />`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Module</Trans>],
      rows: [
        [
          <code key="e">xidIntegration</code>,
          <Trans>Astro integration factory</Trans>,
          <code key="m">@xid-kit/astro</code>,
        ],
        [
          <code key="e">createXidMiddleware</code>,
          <Trans>middleware factory</Trans>,
          <code key="m">@xid-kit/astro</code>,
        ],
        [
          <code key="e">getAuth, currentUser, xidClient</code>,
          <Trans>server helpers</Trans>,
          <code key="m">@xid-kit/astro/server</code>,
        ],
        [
          <code key="e">getClient, initClient, resetClient</code>,
          <Trans>island client singleton</Trans>,
          <code key="m">@xid-kit/astro/client</code>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Security notes</Trans>,
    bullets: [
      <Trans>
        <code>jwtKey</code> is a JWKS public key; it is safe for networkless verification and does
        not contain a private key.
      </Trans>,
      <Trans>
        <code>secretKey</code> (<code>sk_live_xxx</code>) must stay server-side only; never pass it
        to an island or client bundle.
      </Trans>,
      <Trans>
        Protected routes redirect via <code>Response.redirect</code> in middleware before any page
        handler runs; no client-side JS is required.
      </Trans>,
      <Trans>
        Re-exports <Link to="/docs/sdks/backend">@xid-kit/backend</Link>{' '}
        <code>authenticateRequest</code> for the networkless JWT verification path.
      </Trans>,
    ],
  },
]

export const ASTRO_DOC = defineSdkDoc({
  slug: 'sdks/astro',
  packageName: '@xid-kit/astro',
  summary: (
    <Trans>
      Astro integration with SSR middleware, server helpers, and island client singleton for static
      and server-rendered Astro sites.
    </Trans>
  ),
  sections,
})
