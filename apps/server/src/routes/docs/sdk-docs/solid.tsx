// @xid-kit/solid 参考页。API 真相源:packages/solid/src/index.ts 与 primitives.ts。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. SolidJS context provider, signal-based
        primitives, and headless components are implemented. A real IdP round-trip on production
        infrastructure is still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Provider setup</Trans>,
    body: [
      <Trans>
        Wrap your app with <code>XidProvider</code>. It creates an <code>XidClient</code>, calls{' '}
        <code>client.load()</code> on mount to fetch the current session, and tears down via{' '}
        <code>onCleanup</code>.
      </Trans>,
    ],
    code: `import { XidProvider } from '@xid-kit/solid'

export function App() {
  return (
    <XidProvider publishableKey="pk_live_...">
      <Routes />
    </XidProvider>
  )
}`,
  },
  {
    heading: <Trans>Auth primitives</Trans>,
    body: [
      <Trans>
        Each primitive returns reactive <code>Accessor&lt;T&gt;</code> (getter functions). Call them
        in JSX or <code>createEffect</code> to track changes.
      </Trans>,
    ],
    code: `import { createAuth, createUser, createOrganization, createSession } from '@xid-kit/solid'
import { Show } from 'solid-js'

function Profile() {
  const auth = createAuth()
  // auth.isLoaded()  -- Accessor<boolean>
  // auth.isSignedIn() -- Accessor<boolean>
  // auth.userId()    -- Accessor<string | null>
  // auth.getToken()  -- () => Promise<Result<string, XidError>>
  // auth.signOut()   -- (options?) => Promise<Result<null, XidError>>

  return (
    <Show when={auth.isLoaded()} fallback={<p>Loading...</p>}>
      <Show when={auth.isSignedIn()} fallback={<p>Not signed in</p>}>
        <p>Signed in as {auth.userId()}</p>
        <button onClick={() => void auth.signOut()}>Sign out</button>
      </Show>
    </Show>
  )
}`,
  },
  {
    heading: <Trans>createOrganization and createSession</Trans>,
    code: `const org = createOrganization()
// org() is CreateOrganizationReturn
if (org().isSignedIn) {
  console.log(org().organization?.name, org().membership?.role)
  await org().setActive('org_new_id')
}

const session = createSession()
if (session().isSignedIn) {
  const { value: token } = await session().getToken()
  // use token for backend requests
}`,
  },
  {
    heading: <Trans>Headless components</Trans>,
    code: `import { SignInButton, SignOutButton, Protect } from '@xid-kit/solid'

// Navigates to /sign-in by default
<SignInButton signInUrl="/auth/sign-in" redirectUrl="/dashboard">
  Log in
</SignInButton>

// Signs out all sessions; pass sessionId to target one
<SignOutButton redirectUrl="/home">Log out</SignOutButton>

// Role and permission gate
<Protect role="org:admin" fallback={<p>Admins only</p>}>
  <Settings />
</Protect>

<Protect permission="org:member:write" fallback={null}>
  <InviteForm />
</Protect>`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">XidProvider</code>,
          <Trans>component</Trans>,
          <Trans>Creates XidClient, calls load() on mount, tears down via onCleanup</Trans>,
        ],
        [
          <code key="e">createAuth</code>,
          <Trans>primitive</Trans>,
          <Trans>
            isLoaded, isSignedIn, userId, sessionId, session, getToken, signOut as Accessors
          </Trans>,
        ],
        [
          <code key="e">createUser</code>,
          <Trans>primitive</Trans>,
          <Trans>Accessor wrapping discriminated union on isLoaded / isSignedIn / user</Trans>,
        ],
        [
          <code key="e">createOrganization</code>,
          <Trans>primitive</Trans>,
          <Trans>
            Accessor returning organization, membership, and setActive for the active org
          </Trans>,
        ],
        [
          <code key="e">createSession</code>,
          <Trans>primitive</Trans>,
          <Trans>Accessor returning session and getToken for the active session</Trans>,
        ],
        [
          <code key="e">SignInButton</code>,
          <Trans>component</Trans>,
          <Trans>Headless button navigating to the sign-in URL on click</Trans>,
        ],
        [
          <code key="e">SignOutButton</code>,
          <Trans>component</Trans>,
          <Trans>Headless button that calls signOut on click</Trans>,
        ],
        [
          <code key="e">Protect</code>,
          <Trans>component</Trans>,
          <Trans>Role and permission gate with fallback prop</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Token storage</Trans>,
    bullets: [
      <Trans>
        Session tokens are <code>HttpOnly</code> cookies set by the XID Worker. The SDK never stores
        tokens in <code>localStorage</code>.
      </Trans>,
      <Trans>
        <code>getToken()</code> returns a short-lived JWT (60 s) cached by <code>TokenManager</code>{' '}
        in <code>@xid-kit/core</code>.
      </Trans>,
    ],
  },
]

export const SOLID_DOC = defineSdkDoc({
  slug: 'sdks/solid',
  packageName: '@xid-kit/solid',
  summary: (
    <Trans>
      SolidJS context provider, signal-based auth primitives, and headless components on top of
      @xid-kit/core.
    </Trans>
  ),
  sections,
})
