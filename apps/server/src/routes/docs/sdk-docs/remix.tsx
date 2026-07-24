// @xid-kit/remix 参考页。API 真相源:packages/remix/src/index.ts 与 server.ts。

import { Trans } from '@lingui/react/macro'
import { Link } from '../../../lib/router'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. Remix loader/action auth helpers, cookie
        session integration, and OAuth callback handler are implemented. A real IdP round-trip on
        production infrastructure is still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Session storage setup</Trans>,
    code: `// app/sessions.server.ts
import { createXidSessionStorage } from '@xid-kit/remix'

export const sessionStorage = createXidSessionStorage({
  secret: process.env.SESSION_SECRET!, // required: cookie signing secret
  // cookieName: '__xid_session', maxAge: 2592000, secure: true
})`,
  },
  {
    heading: <Trans>Reading auth in loaders</Trans>,
    body: [
      <Trans>
        <code>getAuth</code> extracts a bearer token or session cookie, verifies it networklessly,
        and returns an <code>AuthResult</code>. <code>requireAuth</code> automatically throws a 302
        redirect to <code>redirectPath</code> when unauthenticated.
      </Trans>,
    ],
    code: `import { getAuth, requireAuth } from '@xid-kit/remix'
import { json, redirect } from '@remix-run/node'
import type { LoaderFunctionArgs } from '@remix-run/node'
import { sessionStorage } from '~/sessions.server'

// Optional check
export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await getAuth(request, {
    jwtKey: process.env.XID_JWT_KEY!,
    sessionStorage,
  })
  if (!auth.userId) return redirect('/login')
  return json({ userId: auth.userId, orgId: auth.orgId })
}

// Guard: throws redirect automatically when unauthenticated
export async function protectedLoader({ request }: LoaderFunctionArgs) {
  const auth = await requireAuth(
    request,
    { jwtKey: process.env.XID_JWT_KEY!, sessionStorage },
    { redirectPath: '/login' },
  )
  return json({ userId: auth.userId })
}`,
  },
  {
    heading: <Trans>OAuth callback handler</Trans>,
    body: [
      <Trans>
        <code>handleCallback</code> validates the <code>state</code> parameter to prevent CSRF,
        exchanges the authorization code, and returns a <code>Response</code> with{' '}
        <code>Set-Cookie</code>.
      </Trans>,
    ],
    code: `// app/routes/auth.callback.ts
import { handleCallback } from '@xid-kit/remix'
import type { ActionFunctionArgs } from '@remix-run/node'
import { sessionStorage } from '~/sessions.server'

export async function action({ request }: ActionFunctionArgs) {
  const result = await handleCallback(request, {
    clientId: process.env.XID_CLIENT_ID!,
    redirectUri: process.env.XID_REDIRECT_URI!,
    sessionStorage,
    defaultReturnTo: '/dashboard',
  })

  if (!result.ok) throw new Response(result.error, { status: 400 })
  return result.response // 302 redirect + Set-Cookie
}`,
  },
  {
    heading: <Trans>Client provider (root.tsx)</Trans>,
    code: `import { XidProvider } from '@xid-kit/remix' // re-export from @xid-kit/react
import { useLoaderData, Outlet } from '@remix-run/react'

export default function App() {
  const { auth } = useLoaderData<typeof loader>()
  return (
    <XidProvider
      publishableKey={window.ENV.XID_PUBLISHABLE_KEY}
      initialState={auth.userId ? { userId: auth.userId } : undefined}
    >
      <Outlet />
    </XidProvider>
  )
}`,
  },
  {
    heading: <Trans>Management API client</Trans>,
    code: `import { xidClient } from '@xid-kit/remix'

const client = xidClient({ secretKey: process.env.XID_SECRET_KEY! })

export async function loader() {
  const result = await client.getUser('user_abc')
  if (!result.ok) throw new Response(result.error.message, { status: result.error.status })
  return json(result.value)
}`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">createXidSessionStorage</code>,
          <Trans>function</Trans>,
          <Trans>Remix cookie session storage for XID tokens</Trans>,
        ],
        [
          <code key="e">getAuth</code>,
          <Trans>function</Trans>,
          <Trans>Verify JWT or session token; returns AuthResult</Trans>,
        ],
        [
          <code key="e">requireAuth</code>,
          <Trans>function</Trans>,
          <Trans>Like getAuth but throws a redirect response when unauthenticated</Trans>,
        ],
        [
          <code key="e">handleCallback</code>,
          <Trans>function</Trans>,
          <Trans>OAuth callback: validates state, exchanges code, sets session cookie</Trans>,
        ],
        [
          <code key="e">xidClient</code>,
          <Trans>function</Trans>,
          <Trans>Returns a server-side Management API client bound to the secret key</Trans>,
        ],
        [
          <code key="e">getTokenFromSession, setTokensInSession, clearTokensFromSession</code>,
          <Trans>functions</Trans>,
          <Trans>Low-level token helpers for custom session handling</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Re-exports</Trans>,
    body: [
      <Trans>
        Re-exports all <Link to="/docs/sdks/react">@xid-kit/react</Link> client components and hooks
        so <code>root.tsx</code> needs only one import for both provider and client components.
      </Trans>,
    ],
  },
  {
    heading: <Trans>PKCE and security</Trans>,
    bullets: [
      <Trans>
        Public clients use Authorization Code with PKCE S256. No client secret is stored.
      </Trans>,
      <Trans>
        <code>handleCallback</code> validates the <code>state</code> parameter against the session
        to prevent CSRF.
      </Trans>,
      <Trans>
        Access tokens are stored in <code>HttpOnly</code> session cookies; they are never written to{' '}
        <code>localStorage</code>.
      </Trans>,
    ],
  },
]

export const REMIX_DOC = defineSdkDoc({
  slug: 'sdks/remix',
  packageName: '@xid-kit/remix',
  summary: (
    <Trans>
      Remix loader and action server helpers, cookie session storage, and OAuth callback handler
      with React SDK re-exports.
    </Trans>
  ),
  sections,
})
