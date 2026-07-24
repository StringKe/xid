// @xid-kit/react 参考页。API 真相源:packages/react/src/index.ts。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Provider setup</Trans>,
    code: `import { XidProvider } from '@xid-kit/react'

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <XidProvider publishableKey="pk_live_..." apiUrl="https://xid.dev">
      {children}
    </XidProvider>
  )
}`,
  },
  {
    heading: <Trans>Hooks</Trans>,
    table: {
      headers: [<Trans>Hook</Trans>, <Trans>Returns</Trans>],
      rows: [
        [
          <code key="h">useAuth</code>,
          <Trans>isLoaded, isSignedIn, userId, signOut, getToken</Trans>,
        ],
        [<code key="h">useUser</code>, <Trans>isLoaded, isSignedIn, user: XidUser | null</Trans>],
        [
          <code key="h">useSession</code>,
          <Trans>isLoaded, isSignedIn, session: XidSession | null</Trans>,
        ],
        [
          <code key="h">useSessionList</code>,
          <Trans>isLoaded, sessions, setActive for multi-session switcher</Trans>,
        ],
        [<code key="h">useSignIn</code>, <Trans>Hosted Auth sign-in flow helpers</Trans>],
        [
          <code key="h">useOrganization</code>,
          <Trans>isLoaded, organization: XidOrganization | null, membership</Trans>,
        ],
        [
          <code key="h">useOrganizationList</code>,
          <Trans>isLoaded, userMemberships for organization switcher UI</Trans>,
        ],
        [
          <code key="h">useAPIKeys</code>,
          <Trans>Management API key list and actions for console embeds</Trans>,
        ],
        [
          <code key="h">useXidContext</code>,
          <Trans>Raw XidContextValue (advanced use; prefer typed hooks above)</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Control components</Trans>,
    table: {
      headers: [<Trans>Component</Trans>, <Trans>Props type</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="c">SignedIn</code>,
          <code key="p">SignedInProps</code>,
          <Trans>Renders children only when the session is loaded and signed in</Trans>,
        ],
        [
          <code key="c">SignedOut</code>,
          <code key="p">SignedOutProps</code>,
          <Trans>Renders children only when loaded and not signed in</Trans>,
        ],
        [
          <code key="c">Protect</code>,
          <code key="p">ProtectProps</code>,
          <Trans>Permission and role gate with optional fallback UI</Trans>,
        ],
        [
          <code key="c">XidLoaded</code>,
          <code key="p">XidLoadedProps</code>,
          <Trans>Renders children after SDK hydration completes (isLoaded true)</Trans>,
        ],
        [
          <code key="c">XidLoading</code>,
          <code key="p">XidLoadingProps</code>,
          <Trans>Renders children while SDK is still loading (isLoaded false)</Trans>,
        ],
        [
          <code key="c">XidFailed</code>,
          <code key="p">XidFailedProps</code>,
          <Trans>
            Renders children when SDK load fails with an unrecoverable error (status error)
          </Trans>,
        ],
        [
          <code key="c">XidDegraded</code>,
          <code key="p">XidDegradedProps</code>,
          <Trans>
            Renders children when SDK is loaded but in degraded state (status degraded)
          </Trans>,
        ],
        [
          <code key="c">AuthenticateWithRedirectCallback</code>,
          <code key="p">AuthenticateWithRedirectCallbackProps</code>,
          <Trans>
            OAuth redirect callback handler: reloads session state and redirects to afterSignInUrl
            or calls onSuccess
          </Trans>,
        ],
        [
          <code key="c">RedirectToSignIn</code>,
          <code key="p">RedirectToSignInProps</code>,
          <Trans>Mounts and immediately redirects to the sign-in page</Trans>,
        ],
        [
          <code key="c">RedirectToSignUp</code>,
          <code key="p">RedirectToSignUpProps</code>,
          <Trans>Mounts and immediately redirects to the sign-up page</Trans>,
        ],
        [
          <code key="c">RedirectToUserProfile</code>,
          <code key="p">RedirectToUserProfileProps</code>,
          <Trans>Mounts and immediately redirects to the user profile page</Trans>,
        ],
        [
          <code key="c">RedirectToOrganizationProfile</code>,
          <code key="p">RedirectToOrganizationProfileProps</code>,
          <Trans>Mounts and immediately redirects to the organization profile page</Trans>,
        ],
        [
          <code key="c">RedirectToCreateOrganization</code>,
          <code key="p">RedirectToCreateOrganizationProps</code>,
          <Trans>Mounts and immediately redirects to the create organization page</Trans>,
        ],
        [
          <code key="c">SignInButton</code>,
          <code key="p">SignInButtonProps</code>,
          <Trans>Unstyled button that navigates to the sign-in URL on click</Trans>,
        ],
        [
          <code key="c">SignUpButton</code>,
          <code key="p">SignUpButtonProps</code>,
          <Trans>Unstyled button that navigates to the sign-up URL on click</Trans>,
        ],
        [
          <code key="c">SignOutButton</code>,
          <code key="p">SignOutButtonProps</code>,
          <Trans>Unstyled button that calls signOut on click</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>UI components</Trans>,
    table: {
      headers: [<Trans>Component</Trans>, <Trans>Use</Trans>],
      rows: [
        [<code key="c">SignIn</code>, <Trans>Embedded sign-in panel (Hosted Auth)</Trans>],
        [<code key="c">SignUp</code>, <Trans>Embedded sign-up panel</Trans>],
        [<code key="c">UserAvatar</code>, <Trans>User avatar image with fallback initials</Trans>],
        [
          <code key="c">UserButton</code>,
          <Trans>Avatar menu with session switch and sign-out</Trans>,
        ],
        [<code key="c">UserProfile</code>, <Trans>Account security and profile management</Trans>],
        [<code key="c">OrganizationSwitcher</code>, <Trans>Active org selector</Trans>],
        [<code key="c">OrganizationProfile</code>, <Trans>Members, roles, SSO admin embed</Trans>],
        [<code key="c">CreateOrganization</code>, <Trans>Org creation flow</Trans>],
        [
          <code key="c">OrganizationList</code>,
          <Trans>List of user organizations for switcher UI</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Not yet implemented</Trans>,
    body: [
      <Trans>
        The following are on the public roadmap but are not exported from the current package. Do
        not assume availability in this version.
      </Trans>,
    ],
    table: {
      headers: [<Trans>Symbol</Trans>, <Trans>Design commitment</Trans>],
      rows: [
        [<code key="n">GoogleOneTap</code>, <Trans>One-tap sign-in embed</Trans>],
        [<code key="n">Waitlist</code>, <Trans>Waitlist sign-up gate component</Trans>],
        [<Trans>Billing components</Trans>, <Trans>Usage and plan management embeds</Trans>],
        [<code key="n">useReverification</code>, <Trans>Step-up authentication hook</Trans>],
      ],
    },
  },
  {
    heading: <Trans>Appearance</Trans>,
    body: [
      <Trans>
        Pass <code>appearance</code> to <code>XidProvider</code> to override CSS variables for
        white-label embeds. All user-visible strings use Lingui runtime descriptors; the{' '}
        <code>Appearance</code>, <code>AppearanceVariables</code>, and{' '}
        <code>AppearanceElements</code> types are exported for typed overrides.
      </Trans>,
    ],
  },
]

export const REACT_DOC = defineSdkDoc({
  slug: 'sdks/react',
  packageName: '@xid-kit/react',
  summary: (
    <Trans>
      React 19 provider, hooks, control components, and hosted UI building blocks for customer
      applications.
    </Trans>
  ),
  sections,
})
