# 06 - Developer Experience: SDKs / UI / API / Webhooks

> Chinese version: [`docs/zh-Hans/design/06-developer-experience.md`](../zh-Hans/design/06-developer-experience.md)

Benchmarked against Clerk, the industry reference for developer experience. The goal is full ecosystem
coverage: the server side covers the mainstream runtimes and languages, and the client side covers web
frameworks, mobile, and desktop. The TypeScript SDKs are all current packages, while the Go, Java,
Rust, PHP, Ruby, Python, .NET, Flutter, iOS, Android, macOS, Windows, Linux, and React Native SDKs
have all completed a local build or unit tests. Every SDK still lacks a real IdP round trip, and the
mobile and desktop SDKs still lack device or simulator platform-channel verification, so they **MUST
NOT be described as production SDKs**. The complete status is governed by
`docs/sdks/platform-matrix.md`.

## 1. SDK layering

```
@xid-kit/core      Browser core (session state/tokens/user and organization info/calls, i.e. vanilla JS)
@xid-kit/backend   Server core (web-standard runtimes: Workers/Node/Bun/Deno, networkless JWT verification)
@xid-kit/react     React provider/hooks/components (current, the priority)
@xid-kit/nextjs    Next.js middleware and server helpers (current)
@xid-kit/react-native  React Native redirect/storage (implemented, local tests pass)
Web framework layer  @xid-kit/{vue,nuxt,svelte,angular,remix,astro,solid} (current package)
Server native layer  sdk/{go,java,rust,php,ruby,python,dotnet} (implemented, local build or tests pass)
Mobile               @xid-kit/expo (current package), sdk/{flutter,ios,android} (implemented, local tests pass)
Desktop              sdk/{macos,windows,linux} (implemented, local tests pass), @xid-kit/{electron,tauri} (current package)
The complete status table is in docs/sdks/platform-matrix.md.
```

Core responsibilities: session state (the JWT session token in a cookie, with multi-session account
switching); the `XidClient` / `TokenManager` instance method `getToken()`, which calls
`POST /v1/sessions/token` to obtain a short-lived JWT (about 60 seconds, auto-refreshed before expiry
with concurrent requests deduplicated) and pairs with `jwtKey` for networkless verification (critical
at the edge); a reactive context shared with components and hooks; and a Backend API wrapper handling
authentication and retries.

### 1.1 SDK platform matrix

Full ecosystem coverage (benchmarked against Clerk), split into server and client. The complete status
table is in `docs/sdks/platform-matrix.md`, and the two MUST stay consistent.

Server side (networkless JWT verification / request auth / webhook verification):

- current: `@xid-kit/backend` (web-standard runtimes Cloudflare Workers / Node.js / Bun / Deno, using
  Web Crypto)
- implemented (local build or tests pass): `sdk/go`, `sdk/java`, `sdk/rust`, `sdk/php`, `sdk/ruby`,
  `sdk/python`, `sdk/dotnet`; the real IdP round trip L4 is not complete

Client-side web frameworks (provider / hooks / prebuilt components, on top of `@xid-kit/core`):

- current: `@xid-kit/core` (vanilla JS), `@xid-kit/react`, `@xid-kit/nextjs`
- current package: `@xid-kit/vue`, `@xid-kit/nuxt`, `@xid-kit/svelte`, `@xid-kit/angular`,
  `@xid-kit/remix`, `@xid-kit/astro`, `@xid-kit/solid`

Client-side mobile:

- implemented: `@xid-kit/react-native`, `sdk/flutter`, `sdk/ios` (Swift), `sdk/android` (Kotlin);
  current package: `@xid-kit/expo`. Real device or simulator platform channels and IdP L4 are not
  complete

Client-side desktop:

- implemented: `sdk/macos`, `sdk/windows`, `sdk/linux`; current package: `@xid-kit/electron`,
  `@xid-kit/tauri`. Real desktop runtimes, OS secure storage, and IdP L4 are not complete

The native SDKs all reuse Hosted Auth plus the OIDC Authorization Code + PKCE S256 flow. A public
client does not store a client secret, does not use the implicit flow or the password grant, and does
not duplicate SAML, SCIM, or Management API business logic.

Native API surface:

```text
configure(options)
signIn(options)
handleRedirect(url)
getSession()
getAccessToken(options)
signOut()
setTokenStorage(adapter)
```

## 2. React SDK components (using Clerk's 34 as the baseline)

### Authentication components

`<SignIn />` `<SignUp />` `<GoogleOneTap />` `<Waitlist />` `<TaskChooseOrganization />`
`<TaskResetPassword />` `<TaskSetupMFA />`

### User components

`<UserButton />` (avatar button, multi-session switching plus sign-out), `<UserProfile />` (account
management: email, phone, security, connected accounts), `<UserAvatar />`

### Organization components

`<OrganizationSwitcher />` `<OrganizationProfile />` (members, roles, SSO, domains)
`<CreateOrganization />` `<OrganizationList />`

### Billing components (not started, planned)

`<PricingTable />` `<CheckoutButton />` `<PlanDetailsButton />` `<SubscriptionDetailsButton />`

### Control components

`<XidProvider />` `<Show when="signed-in|signed-out" />` `<XidLoaded />` `<XidLoading />`
`<XidFailed />` `<XidDegraded />` `<AuthenticateWithRedirectCallback />` `<RedirectToSignIn />`
`<RedirectToSignUp />` `<RedirectToUserProfile />` `<RedirectToOrganizationProfile />`
`<RedirectToCreateOrganization />`

### Unstyled buttons

`<SignInButton />` `<SignUpButton />` `<SignOutButton />`

## 3. React hooks

Authentication and session: `useAuth()` (isSignedIn/userId/sessionId/getToken/signOut), `useUser()`,
`useXid()` (the full instance, with imperative methods such as openSignIn), `useSession()`,
`useSessionList()`, `useSignIn()` (unified low-level control over sign-in and user creation)

Organization: `useOrganization()`, `useOrganizationList()`, `useOrganizationCreationDefaults()`

Advanced (not started, planned): `useReverification()` (re-verification for sensitive operations),
`useWaitlist()`

Billing/API key: `useCheckout`, `usePlans`, `useSubscription`, `usePaymentMethods`, `useAPIKeys`, and
others (iterative)

## 4. Next.js SDK specifics

- `xidMiddleware()`: edge middleware that protects routes, reads the auth state, and sets the locale
- `auth()`: App Router server-side session access (no request argument needed; React cache
  deduplicates automatically)
- `currentUser()`: server-side access to the full User
- `getAuth()`: Pages Router getServerSideProps
- `xidClient`: the server-side entry point to the Management API

## 5. Hosted UI (the Account Portal equivalent)

Zero-configuration hosted pages, with 12 public authentication pages: sign-in (`/sign-in`), sign-up
(`/sign-up`, a redirect shell), forgot password (`/forgot-password`), reset password
(`/reset-password`), email verification (`/verify-email`), MFA challenge (`/mfa`), consent
(`/consent`), activate (`/activate`), CIBA activation (`/ciba-activation`), accept invitation
(`/accept-invitation`), create organization (`/create-organization`), and select organization
(`/select-organization`). There are also 5 account self-service pages (account settings and
self-management).

### Technology stack

The Hosted UI is a React 19 SPA built inside the same `apps/server` project as the Worker, with
`@cloudflare/vite-plugin` producing both the Worker bundle and the static SPA assets. It is not hosted
separately on R2; the assets are served directly by Cloudflare Workers Static Assets (the ASSETS
binding), configured in `wrangler.jsonc`:

```jsonc
{
  "main": "worker/index.ts",
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
  },
}
```

`not_found_handling=single-page-application` makes the CDN layer fall back to `index.html` for every
unmatched path (`/sign-in`, `/user`, `/organization`, and the other SPA routes) without any Worker
code, which reduces cold-start overhead. Inside the SPA, `@tanstack/react-router` handles routing (a
code-based route tree in `apps/server/src/router.tsx`), and `lib/router.tsx` provides a react-router
compatibility layer that existing pages can keep using.

Build output directories:

```
dist/
  client/          Vite SPA build output (static assets)
  worker/          Worker bundle
```

`vite.config.ts` (`apps/server/vite.config.ts`) uses a standard Vite configuration, with this plugin
order:

```ts
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { lingui } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import { linguiTransformerBabelPreset } from '@lingui/vite-plugin'

plugins: [react(), cloudflare(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })]
```

### Worker fallback for non-API paths

The Worker `worker/index.ts` mounts every protocol endpoint and the Management API through Hono, with
path prefixes starting with `/api/`, `/.well-known/`, `/oauth/`, `/scim/`, and `/saml/`. Non-API paths
flow like this:

1. Hono matches no route -> the Worker does not intercept, and the request passes through to the
   ASSETS binding.
2. The ASSETS binding looks for the corresponding static file under `dist/client/`.
3. The file does not exist -> `not_found_handling=single-page-application` returns
   `dist/client/index.html`, handled at the CDN layer without involving the Worker.
4. The SPA bootstraps in the browser, `@tanstack/react-router` matches the current path, and the
   corresponding page component renders.

The explicit fallback shape inside the Worker (if you need to control it at the Worker layer):

```ts
// worker/index.ts
import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

// Mount the protocol endpoints and the Management API
app.route('/api', apiRouter)
app.route('/.well-known', discoveryRouter)
app.route('/oauth', oauthRouter)
// ... other protocol routes

// No catch-all handler for non-API paths; the ASSETS binding takes over automatically
export default app
```

The ASSETS binding is declared in `wrangler.jsonc` and injected automatically by the Cloudflare
platform, so there is no need to call `env.ASSETS.fetch` manually in the Worker (unless you need to
authenticate at the Worker layer before deciding whether to serve assets).

### The 302 redirect flow when /authorize receives an unauthenticated request

The OIDC `/authorize` endpoint is handled at the Worker layer. When a request arrives without a valid
session, it redirects to the SPA sign-in page as follows, and after sign-in the session comes back and
the OIDC flow resumes:

**Step 1: the Worker saves the OIDC request context**

When `/authorize` receives an unauthenticated request, it encodes the complete original query string
(`response_type`, `client_id`, `scope`, `redirect_uri`, `state`, `code_challenge`,
`code_challenge_method`, `nonce`, and so on) and stores it temporarily in OAuthFlowDO (key =
`authz:{tenantId}:{authz_request_id}`, where `authz_request_id` is a random UUID, with a 10-minute TTL
and single-use consumption). The Durable Object holds only the protocol recovery context; the
organization is resolved by the instance login resolver, the authorize request, the Host, or an
explicit internal hint.

**Step 2: the Worker returns a 302 to the SPA sign-in route**

```
HTTP/1.1 302 Found
Location: /sign-in?authz_request_id=<uuid>
```

The full OIDC parameters are not appended to the redirect URL, which keeps sensitive parameters such
as `redirect_uri` out of browser history and referrers.

**Step 3: the SPA sign-in page renders and authenticates**

The SPA `/sign-in` route reads the `authz_request_id` parameter and calls `GET /auth/config` on the
Worker to fetch the tenant's authentication configuration (enabled sign-in methods, branding, and so
on). The user completes authentication (magic link, email OTP, password, passkey, SSO, and so on), and
the Worker issues a session cookie (`HttpOnly; Secure; SameSite=Lax`).

**Step 4: after sign-in the SPA returns to /authorize**

On a successful sign-in, the SPA reads the current `authz_request_id` and navigates to:

```
/authorize?authz_request_id=<uuid>
```

When the Worker `/authorize` endpoint receives an `authz_request_id` parameter, it restores the
original OIDC request parameters from OAuthFlowDO (single-use consumption: the Durable Object record
is deleted on restore), verifies the session cookie, and continues with the normal authorization code
issuance flow (PKCE validation, consent check, code issuance, 302 to redirect_uri).

**Key constraints**

- The authorization request in OAuthFlowDO is consumed exactly once: it is deleted as soon as
  `/authorize` restores it, which prevents replay.
- 10-minute TTL: after it expires, `/authorize?authz_request_id=xxx` is treated as `invalid_request`
  because the Durable Object record is gone, and the user is asked to start over.
- User cancels sign-in: the SPA navigates to
  `redirect_uri?error=access_denied&state=<original_state>` (reading the state from the restored
  authorization request) rather than redirecting to `/authorize`, which avoids a redirect loop.
- The consent page is also an SPA route: when `/authorize` has a valid session but no consent, it uses
  the same 302 mechanism to redirect to `/consent?authz_request_id=<uuid>`. The consent page calls
  `GET /auth/consent-params?prompt_id=<uuid>` (where `prompt_id` equals `authz_request_id`) to fetch
  the client display data and the localized scope list. `/mfa` and `/select-organization` use the same
  302 mechanism.

**Complete flow sequence**

```
RP -> GET /authorize?... (not signed in)
       Worker -> store OAuthFlowDO (key=authz:{tenantId}:{uuid}, pendingParams, TTL 10min)
              -> 302 /sign-in?authz_request_id=uuid
Browser -> GET /sign-in?authz_request_id=uuid
           ASSETS -> index.html (SPA bootstrap)
           SPA -> GET /auth/config (fetch the tenant authentication configuration)
           user completes authentication
           SPA -> POST the authentication endpoint (the Worker issues the session cookie)
               -> the frontend navigates to /authorize?authz_request_id=uuid
Worker -> GET /authorize?authz_request_id=uuid
          verify the session cookie
          restore pendingParams from OAuthFlowDO (single-use consumption, the DO record is deleted)
          run the consent check / issue the code
       -> 302 <redirect_uri>?code=...&state=...
```

### Integration model tradeoffs

| Dimension   | Embeddable (the Clerk model)                         | Redirect-hosted (the Auth0 model)              |
| ----------- | ---------------------------------------------------- | ---------------------------------------------- |
| Experience  | No redirect, smooth                                  | Redirects to a third-party domain, jarring     |
| Branding    | Entirely your own domain                             | Limited by the hosted page's customization     |
| Security    | The frontend touches the auth flow, so watch for XSS | Credentials never reach the developer's server |
| Integration | Low effort (npm plus a Provider)                     | Medium effort (configure callbacks and CORS)   |

XID's decision: prioritize embeddable components (the best developer experience) while also providing
the Hosted UI as a zero-configuration starting point and fallback. The Hosted UI shares the Worker's
origin (so there are no cross-origin problems), and once the RP 302s the user to `/authorize` the
entire authentication flow completes inside the same Worker plus SPA.

### Branding customization tiers

- Hosted pages: dashboard configuration (colors and logo); arbitrary CSS is not supported
- Embedded components: the appearance prop plus a theme (including shadcn themes), with variable
  overrides and CSS class names
- Fully custom: build your own UI with the hooks

## 6. Backend SDK

Runtimes: Node (express/fastify/nextjs), Cloudflare Workers/Pages (networkless), Vercel Edge, Bun, and
Deno. Built on standard V8 web APIs.

Token and session verification:

- `authenticateRequest(request, options)`: checks the Authorization header or the cookie and verifies
  the JWT signature, exp, and azp
- `verifyToken(token, options)`: the low-level call; passing jwtKey skips the network request
- `verifyWebhook(request, options)`: HMAC signature verification

Networkless mode: pass `jwtKey` (the JWKS public key) and no API request is needed, which suits edge
cold starts.

## 7. Management API (REST)

| Resource                      | Operations                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| users                         | CRUD, search (email/phone/name/external_id), ban/unban, impersonate, metadata PATCH |
| organizations                 | CRUD, logo, domain verification                                                     |
| memberships                   | list/create/update role/delete                                                      |
| invitations                   | create (bulk rate-limited), revoke, list                                            |
| sessions                      | list/get/revoke                                                                     |
| applications/clients          | CRUD, secret rotate                                                                 |
| connections (SSO)             | CRUD                                                                                |
| directories (SCIM)            | CRUD, token rotate                                                                  |
| roles/permissions             | CRUD                                                                                |
| emailAddresses/phoneNumbers   | create/delete/setPrimary                                                            |
| allowlistIdentifiers          | create/delete/list                                                                  |
| oauthApplications             | CRUD (XID acting as an OAuth IdP)                                                   |
| redirectUrls                  | create/delete                                                                       |
| webhooks                      | CRUD                                                                                |
| apiKeys                       | create/list/revoke                                                                  |
| billing (plans/subscriptions) | CRUD                                                                                |

Authentication: a secret key (`Authorization: Bearer sk_live_xxx`) plus M2M tokens (service to
service, `POST /oauth/token`). Pagination: cursor plus offset/limit (100 per page maximum). Rate
limits: metadata PATCH 10 per 10 seconds per user, bulk invitations 50 per hour. Versioning: the
URL prefix `/v1/`.

## 8. Webhooks and the event system

### Event naming `<object>.<action>` (following WorkOS's fine granularity, which has high audit value)

- user: created/updated/deleted
- guest: created/converted/gc_deleted (see chapter 01 section 8 and section 10 below)
- session: created/ended/removed/revoked
- organization: created/updated/deleted
- organizationMembership: created/updated/deleted
- organizationInvitation: created/accepted/revoked
- organizationDomain: created/updated/deleted/verified/verification_failed
- authentication: password_succeeded/failed, passkey__, mfa__, oauth__, sso__, magic_auth__,
  email_verification__, radar_risk_detected
- connection (SSO): activated/deactivated/deleted/saml_certificate_renewed/renewal_required
- dsync (directory sync): activated/deleted, user.created/updated/deleted,
  group.created/updated/deleted, group.user_added/removed
- role/permission: created/updated/deleted
- email/sms: created (when the developer takes over sending)
- billing: subscription._, paymentAttempt._

### Delivery

- An in-house delivery layer (Svix-style) or an integration with Svix
- Retries: exponential backoff with automatic retries; dead letters go to D1
- Manual replay: by message or by time range
- Signature verification: the payload carries svix-id, svix-timestamp, and svix-signature, using
  HMAC-SHA256 with a 5-minute window for replay defense
- Idempotency: developers handle duplicate events themselves
- Delivery goes through Cloudflare Queues for decoupling and never blocks the sign-in path
- Event stream (Events API): an ordered immutable event stream with cursor pagination (following
  WorkOS; pull-based, for reliable synchronization)

## 9. Other developer experience items

- API keys are a first-class resource with scoped permissions, managed from the frontend through
  `useAPIKeys` and through backend CRUD
- Structured errors: XidAPIError (code/message/longMessage/meta.paramName), mapping precisely onto
  form fields
- Local development: a dev instance (`pk_test_`), certificate-free localhost (through an HTTPS proxy),
  and testing tokens that bypass bot detection
- Documentation: a dedicated page per component and hook (a props table plus examples), a playground,
  and shadcn/Tailwind integration examples

## 10. Guest sign-in (anonymous)

The design contract is chapter 01 section 8. Status: implemented (endpoint, conversion routing,
GuestStore DO, GC cron, React and native SDK APIs); the per-platform status lives in
`docs/sdks/platform-matrix.md`.

- Endpoint: `POST /auth/guest`, an unauthenticated private extension (not a standard OIDC
  capability). It creates the anonymous user plus session, returns JSON aligned with the existing
  me-auth sign-in response shape (session handle, expiry), and sets the session cookie in the
  browser scenario. A request that already carries a valid guest session gets a 200 renewal with no
  new user. The endpoint is guarded by Turnstile plus RateLimitStore and a per-tenant daily mint
  cap; chapter 01 section 8 holds the full four-layer anti-duplicate contract.
- SDK API: `signInAnonymously()` creates a guest, or lazily reuses the local guest credential when
  one is still valid (the SDK does not call the endpoint in that case, the Firebase semantics).
  `isAnonymous` reflects whether the current token `amr` carries `guest`. Upgrade guidance keeps
  prompting the user to convert; after any credential ceremony the SDK compares the `sub` of the old
  and new tokens and exposes a merge hook for the RP application layer, which matters only on the
  email-occupied path where the sub changes.
- Management API: the `/v1/users` list supports the `?provisioned_by=anonymous` filter; no new
  endpoint is added.
- Audit and webhook event names (see section 8): `guest.created`, `guest.converted`, and
  `guest.gc_deleted`.
