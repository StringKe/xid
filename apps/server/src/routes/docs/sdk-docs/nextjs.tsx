// @xid-kit/nextjs 参考页。API 真相源:packages/nextjs/src/index.ts。

import { Trans } from '@lingui/react/macro'
import { Link } from '../../../lib/router'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Middleware</Trans>,
    body: [
      <Trans>
        <code>xidMiddleware()</code> runs on the Edge Runtime, verifies the session JWT
        networklessly, and injects auth state into downstream request headers for server components
        and route handlers.
      </Trans>,
    ],
    code: `import { xidMiddleware } from '@xid-kit/nextjs'

export default xidMiddleware({
  jwtKey: process.env.XID_JWKS_PUBLIC_KEY!,
  issuer: 'https://xid.dev',
})

export const config = {
  matcher: ['/dashboard(.*)', '/api/protected(.*)'],
}`,
  },
  {
    heading: <Trans>App Router server helpers</Trans>,
    code: `import { auth, currentUser } from '@xid-kit/nextjs'

export default async function DashboardPage() {
  const { userId } = await auth()
  if (!userId) return null
  const user = await currentUser()
  return <p>Welcome {user?.email}</p>
}`,
  },
  {
    heading: <Trans>Pages Router</Trans>,
    code: `import { getAuth } from '@xid-kit/nextjs'

export const getServerSideProps = async (ctx) => {
  const { userId } = await getAuth(ctx.req)
  if (!userId) return { redirect: { destination: '/sign-in', permanent: false } }
  return { props: {} }
}`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">xidMiddleware</code>,
          <Trans>function</Trans>,
          <Trans>Edge Runtime middleware: verifies JWT, injects auth headers</Trans>,
        ],
        [
          <code key="e">auth</code>,
          <Trans>function</Trans>,
          <Trans>App Router: returns AuthObject with userId, orgId, orgRole</Trans>,
        ],
        [
          <code key="e">getAuth</code>,
          <Trans>function</Trans>,
          <Trans>Pages Router: returns AuthObject from IncomingMessage</Trans>,
        ],
        [
          <code key="e">currentUser</code>,
          <Trans>function</Trans>,
          <Trans>App Router: fetches full user object using server auth context</Trans>,
        ],
        [
          <code key="e">xidClient</code>,
          <Trans>function</Trans>,
          <Trans>Returns server-side XidApiClient bound to current request auth</Trans>,
        ],
        [
          <code key="e">XID_AUTH_HEADER</code>,
          <Trans>string constant</Trans>,
          <Trans>Header name for auth state between middleware and server components</Trans>,
        ],
        [
          <code key="e">XidMiddlewareOptions</code>,
          <Trans>type</Trans>,
          <Trans>Options for xidMiddleware: jwtKey, issuer, publicRoutes, ignoredRoutes</Trans>,
        ],
        [
          <code key="e">XidServerClientOptions</code>,
          <Trans>type</Trans>,
          <Trans>Options for xidClient</Trans>,
        ],
        [
          <code key="e">AuthObject</code>,
          <Trans>type</Trans>,
          <Trans>Authenticated state: userId, orgId, orgRole, sessionId</Trans>,
        ],
        [
          <code key="e">UnauthenticatedAuthObject</code>,
          <Trans>type</Trans>,
          <Trans>Unauthenticated state with null fields</Trans>,
        ],
        [
          <code key="e">AuthResult</code>,
          <Trans>type</Trans>,
          <Trans>Union of AuthObject and UnauthenticatedAuthObject</Trans>,
        ],
        [
          <code key="e">PaginationParams</code>,
          <Trans>type</Trans>,
          <Trans>Cursor and limit params for Management API list calls</Trans>,
        ],
        [
          <code key="e">PaginatedResponse{'<T>'}</code>,
          <Trans>type</Trans>,
          <Trans>Paginated response envelope</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Re-exports</Trans>,
    bullets: [
      <Trans>
        Re-exports all <Link to="/docs/sdks/react">@xid-kit/react</Link> client components and hooks
        via <code>{'export * from "@xid-kit/react"'}</code>.
      </Trans>,
      <Trans>
        Re-exports from <Link to="/docs/sdks/backend">@xid-kit/backend</Link>:{' '}
        <code>verifyToken</code>, <code>verifyWebhook</code>, <code>authenticateRequest</code>,{' '}
        <code>JwksCache</code>, <code>toVerifyKeySet</code>, <code>AppError</code>,{' '}
        <code>BACKEND_ERROR_CODES</code>, and all their associated types.
      </Trans>,
      <Trans>Server helpers never expose signing secrets to client bundles.</Trans>,
    ],
  },
]

export const NEXTJS_DOC = defineSdkDoc({
  slug: 'sdks/nextjs',
  packageName: '@xid-kit/nextjs',
  summary: (
    <Trans>
      Next.js middleware, App Router and Pages Router server helpers, plus React SDK re-exports.
    </Trans>
  ),
  sections,
})
