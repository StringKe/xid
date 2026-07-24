// @xid-kit/core 参考页。API 真相源:packages/core/src/index.ts。

import { Trans } from '@lingui/react/macro'
import { Link } from '../../../lib/router'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Install and configure</Trans>,
    body: [
      <Trans>
        Point <code>apiUrl</code> at your XID instance origin (hosted or self-hosted). The SDK never
        stores a client secret and does not expose refresh token material to browser scripts.
      </Trans>,
    ],
    code: `import { XidClient } from '@xid-kit/core'

const xid = new XidClient({ apiUrl: 'https://xid.dev' })
await xid.load()
const token = await xid.getToken()`,
  },
  {
    heading: <Trans>Session lifecycle</Trans>,
    bullets: [
      <Trans>
        <code>load()</code> reads <code>/v1/me</code> and hydrates user, session, and active
        organization.
      </Trans>,
      <Trans>
        <code>signInPassword()</code> establishes a cookie session through Hosted Auth password
        flow.
      </Trans>,
      <Trans>
        <code>getToken()</code> returns a short-lived JWT for API calls. Verify networklessly on
        your backend with JWKS.
      </Trans>,
      <Trans>
        <code>setActiveOrganization()</code> switches org context and clears the token cache before
        reloading state.
      </Trans>,
      <Trans>
        <code>signOut()</code> revokes the browser session cookie.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Management API helpers</Trans>,
    body: [
      <Trans>
        The current version wraps API key management only. All other Management API resources
        require direct <code>/v1/</code> REST calls with{' '}
        <code>Authorization: Bearer sk_live_xxx</code>.
      </Trans>,
    ],
    code: `const keys = await xid.listApiKeys()
const created = await xid.createApiKey({ name: 'CI deploy', scopes: ['read'] })
await xid.revokeApiKey(created.id)`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">XidClient</code>,
          <Trans>class</Trans>,
          <Trans>
            Top-level browser client: load, signIn, getToken, setActiveOrganization, signOut, and
            Management API helpers
          </Trans>,
        ],
        [
          <code key="e">XidStore</code>,
          <Trans>class</Trans>,
          <Trans>
            Framework-agnostic reactive store; subscribe with useSyncExternalStore in framework
            bindings
          </Trans>,
        ],
        [
          <code key="e">TokenManager</code>,
          <Trans>class</Trans>,
          <Trans>Short-lived JWT cache and scheduled refresh (advanced use and testing)</Trans>,
        ],
        [
          <code key="e">XidApiClient</code>,
          <Trans>class</Trans>,
          <Trans>HTTP client for /v1/me and token endpoints</Trans>,
        ],
        [
          <code key="e">XidNetworkError</code>,
          <Trans>class</Trans>,
          <Trans>
            Thrown on transport failures: network error, non-JSON response, 5xx with no structured
            body
          </Trans>,
        ],
        [
          <code key="e">makeXidError</code>,
          <Trans>function</Trans>,
          <Trans>
            Construct a structured XidError for local validation failures without a network
            round-trip
          </Trans>,
        ],
        [
          <code key="e">isXidErrorShape</code>,
          <Trans>function</Trans>,
          <Trans>
            Type guard: checks whether an unknown value conforms to XidError shape from the wire
          </Trans>,
        ],
        [
          <code key="e">decodeTokenClaims</code>,
          <Trans>function</Trans>,
          <Trans>
            Decode JWT payload claims for expiry scheduling only; does not verify the signature
          </Trans>,
        ],
        [
          <code key="e">isTokenExpiring</code>,
          <Trans>function</Trans>,
          <Trans>
            Returns true when the token expires within the leeway window (default 10 s)
          </Trans>,
        ],
        [
          <code key="e">SESSION_STATUS</code>,
          <Trans>as const tuple</Trans>,
          <Trans>
            Valid session status values: active, pending, expired, removed, ended, revoked
          </Trans>,
        ],
        [
          <code key="e">CLIENT_STATUS</code>,
          <Trans>as const tuple</Trans>,
          <Trans>Valid client status values: loading, ready, degraded, error</Trans>,
        ],
        [
          <code key="e">PACKAGE</code>,
          <Trans>string constant</Trans>,
          <Trans>Package name identifier '@xid-kit/core'</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Types</Trans>,
    table: {
      headers: [<Trans>Type</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="t">XidUser</code>,
          <Trans>Read-only view of the authenticated user (no secrets or hashes)</Trans>,
        ],
        [<code key="t">XidOrganization</code>, <Trans>Public organization view</Trans>],
        [
          <code key="t">XidOrganizationMembership</code>,
          <Trans>User membership in an org with role and permissions</Trans>,
        ],
        [
          <code key="t">XidSession</code>,
          <Trans>Session view including status, expiry, and active org</Trans>,
        ],
        [<code key="t">XidApiKey</code>, <Trans>API key without secret (list view)</Trans>],
        [
          <code key="t">XidApiKeyWithSecret</code>,
          <Trans>API key returned once at creation; includes the key field</Trans>,
        ],
        [<code key="t">XidPage{'<T>'}</code>, <Trans>Cursor-paginated response envelope</Trans>],
        [<code key="t">CreateApiKeyInput</code>, <Trans>Input for createApiKey</Trans>],
        [<code key="t">SignInPasswordInput</code>, <Trans>Input for signInPassword</Trans>],
        [
          <code key="t">SignInResult</code>,
          <Trans>Result from signInPassword: next step or redirect URL</Trans>,
        ],
        [<code key="t">SessionStatus</code>, <Trans>Union of SESSION_STATUS values</Trans>],
        [<code key="t">ClientStatus</code>, <Trans>Union of CLIENT_STATUS values</Trans>],
        [
          <code key="t">XidState</code>,
          <Trans>Full SDK state snapshot subscribed from XidStore</Trans>,
        ],
        [<code key="t">XidStateListener</code>, <Trans>State change listener callback type</Trans>],
        [<code key="t">Unsubscribe</code>, <Trans>Return type of XidStore.subscribe</Trans>],
        [
          <code key="t">GetTokenOptions</code>,
          <Trans>Options for getToken: template, skipCache, leewaySeconds, signal</Trans>,
        ],
        [
          <code key="t">XidClientOptions</code>,
          <Trans>Constructor options for XidClient: apiUrl, fetcher, now</Trans>,
        ],
        [<code key="t">TokenResponse</code>, <Trans>Raw token endpoint response shape</Trans>],
        [<code key="t">ClientStateResponse</code>, <Trans>Raw /v1/me response shape</Trans>],
        [
          <code key="t">DecodedTokenClaims</code>,
          <Trans>JWT payload claims returned by decodeTokenClaims</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Related docs</Trans>,
    body: [
      <Trans>
        Framework bindings: <Link to="/docs/sdks/react">@xid-kit/react</Link>. Server verification:{' '}
        <Link to="/docs/sdks/backend">@xid-kit/backend</Link>.
      </Trans>,
    ],
  },
]

export const CORE_DOC = defineSdkDoc({
  slug: 'sdks/core',
  packageName: '@xid-kit/core',
  summary: (
    <Trans>
      Browser client for session state, short-lived JWT access, and Management API helpers.
    </Trans>
  ),
  sections,
})
