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

`@xid-kit/core` has two explicit browser modes:

- `oidc` is the default for a developer application on a different origin. It requires the
  registered OAuth `clientId`, `issuer`, and exact `redirectUri`; starts `/authorize` with state,
  nonce, and PKCE S256; validates the callback; exchanges the code at `/token`; verifies the ID token
  against JWKS; and calls `/userinfo` with the access token. The public `client_id` is the SDK
  identifier. There is no separate `pk_live_` or `pk_test_` publishable-key database, and Management
  API keys MUST NOT be reused as browser identifiers. The first browser release does not request
  `offline_access`, so it stores no bearer refresh token and reauthorizes after the access session
  expires.
- `intent: "sign-up"` in an OIDC SDK call is an RP user-registration hint, not XID product
  onboarding. The SDK emits `xid_intent=sign-up`; after `client_id` validation the Core maps it to
  the internal Hosted Auth `application-sign-up` flow. The resulting user and default Membership
  stay in the Application owner's existing Tenant and the flow resumes `/authorize`. Only the
  same-origin product route `/sign-up` uses `intent=sign-up` to create a new top-level Organization.
- `same-origin` is only for Core-owned UI, Console on the same hostname, or a deployment that
  deliberately reverse-routes Core authentication endpoints onto the application's exact origin.
  It uses HttpOnly opaque `__Host-xid.rt.*` cookies, supports multi-session account switching, and
  exchanges the active cookie session through `POST /v1/sessions/token`. An absolute `apiUrl` whose
  origin differs from the current page is rejected in this mode; a browser MUST NOT attempt to make
  Core cookies into third-party application credentials.

Both modes expose the same reactive signed-in state and `getToken()` baseline. Cookie-only
capabilities such as multi-session switching, direct credential calls, guest creation, and
same-origin account-management mutations are explicitly unavailable in `oidc` mode until a bearer
self-service contract exists. Browser or framework code never parses an opaque refresh cookie as a
JWT.

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

The cross-origin Web and native SDKs all reuse Hosted Auth plus the OIDC Authorization Code + PKCE
S256 flow. A public client uses `token_endpoint_auth_method=none`, never receives or stores a client
secret, cannot disable PKCE, does not use the implicit flow or password grant, and does not duplicate
SAML, SCIM, or Management API business logic. Public clients that need refresh tokens use DPoP;
without sender binding they register authorization code only.

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
binding), configured in `wrangler.jsonc`. This Core SPA contains sign-in, consent, MFA, organization
selection, and account self-service. It does not contain the public site, public docs, or management
Console.

```jsonc
{
  "main": "worker/index.ts",
  "assets": {
    "binding": "ASSETS",
    "run_worker_first": true,
  },
}
```

`run_worker_first=true` sends document requests through Hono before Static Assets. The Worker serves
the SPA shell only for the exact paths in `CORE_SPA_ROUTE_PATHS`, including `/sign-in`, `/account`,
and the other declared Hosted UI routes. It rewrites those GET or HEAD requests to the `/` asset
entry while preserving the browser URL. Unknown paths are not SPA fallbacks: Core performs an exact
asset lookup and preserves the missing asset's real 404 response. More-specific Cloudflare Worker
Routes select the Nimbus Site and Console before Core. Inside the Core SPA,
`@tanstack/react-router` handles the declared routes, and the router compatibility layer lets
existing pages keep their navigation API.

Build output directories:

```
dist/
  client/          Vite SPA build output (static assets)
  worker/          Worker bundle
```

### Public documentation and Console runtime boundaries

Public presentation is one Nimbus 0.8.2 documentation deployment, not a separate marketing site.
Nimbus owns the canonical apex documentation hub, 8-locale docs, Pagefind, OG images, sitemaps,
Markdown twins, LLM documents, and structured metadata. English uses `/` and `/{slug}`. The other
7 locales use `/{locale-segment}` and `/{locale-segment}/{slug}`. The published surface contains
one hub plus 40 documents and one status page per locale, for 336 pages total. The locale-neutral
`documents.json` AST is the content source for the 328 generated collection pages; the localized
status routes are explicit Astro pages. Generated localized MDX is a build artifact and is not an
authoring source.

The installed Nimbus Registry feature set is:

- `pagefind-search`: indexes all 336 localized Site pages.
- `ai-native`: emits one downleveled `.md` twin and one source-preserving `.mdx` twin for every
  published page. Global `/llms.txt` and `/llms-full.txt` cover all 336 pages. English locale
  endpoints under `/en/` and the other 7 locale endpoints under their locale segment each cover
  42 pages. Each locale also emits a Nimbus-compatible SDK section index and corpus at
  `/sdks/llms*.txt` or `/{locale-segment}/sdks/llms*.txt`, covering exactly its 29 SDK pages. It
  also emits robots and sitemaps.
- `404-page`: returns a localized terminal Site 404 for unknown public routes without entering Core.
- `mermaid`: converts AST CodeBlock entries whose language is `mermaid` into theme-aware diagrams
  with a full-screen dialog. Diagram source stays intact in both Markdown twins.
- `lint-prose-textlint`: regenerates the content collection and applies the English prose gate only
  to the generated English docs subtree.

Every published HTML page carries canonical and hreflang links, Open Graph metadata, and JSON-LD.
The availability of another upstream Registry recipe does not enable it in XID. In particular,
`changelog`, `new-version`, and `new-collection` are not part of this shipped surface.

Legacy `/docs` paths return a 308 to the root canonical tree when registered. An unknown legacy
`/docs/*` path returns the Nimbus 404 and never falls through to Hosted Auth. The English SCIM
documentation uses exact `/scim` routes only, so `/scim/v2/*` remains owned by Core.

The org and instance management surfaces remain one unified React Console product, but their static
assets are deployed by a separate Console Worker. That Worker has only an `ASSETS` binding and owns
`/console` and `/console/*` on both the apex and tenant hosts. It has no database, cache, object
storage, Durable Object, queue, secret, protocol, or Management API binding.

The browser keeps the original host for Console document navigation and same-origin API calls. Sign
in, MFA, account, `/auth/*`, and `/v1/*` continue to resolve to Core. This preserves the host-only
`__Host-` session cookies on both apex and tenant hosts. Cross-runtime links use document navigation
instead of client-router navigation.

Cloudflare Worker Routes provide the split. More-specific Site and Console routes take precedence
over the Core Custom Domain and tenant wildcard fallback. Neither frontend Worker claims a broad
apex catch-all, and there is no front proxy Worker.

Because Cloudflare matches the complete URL including the query string, exact Site and Console
patterns can fall through to Core when a query is present. Core uses the shared ownership contract
and one-way Service Bindings to delegate only those exact frontend requests with the original URL
unchanged. Unknown and typo paths remain Core 404s, and neither frontend Worker binds back to Core.

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

### Core Worker fallback for Hosted UI paths

The Core Worker mounts every protocol endpoint and the Management API through Hono. Core-owned human
paths flow like this:

1. The request does not match a more-specific Site or Console Worker Route.
2. Hono handles registered protocol and API routes. The unmatched-protocol blocker returns a real
   protocol-shaped 404 for reserved protocol and API prefixes.
3. `registerPublicAssetRoutes()` rejects paths owned by Site or Console, then evaluates
   `isCoreSpaRoute(pathname)` against the shared exact route manifest.
4. An exact Hosted UI route with GET or HEAD is rewritten to the `/` asset entry and receives the
   SPA shell. The browser URL is unchanged; non-document methods return 404.
5. Every other Core-owned path is fetched from ASSETS without rewriting. A real asset is served, and
   a missing asset or unknown document path remains a real 404. It never receives the SPA shell.

The relevant fallback shape inside the Worker is:

```ts
// worker/public-assets.ts
if (isCoreSpaRoute(url.pathname)) {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return new Response(null, { status: 404 })
  }
  return serveSpaAsset(c, spaEntryRequest(c.req.raw))
}
return serveSpaAsset(c)
```

The ASSETS binding is declared in `wrangler.jsonc`. Core intentionally calls `env.ASSETS.fetch`
after ownership and exact-route checks because the Worker, not the Static Assets SPA mode, owns the
fallback decision.

### The 302 redirect flow when /authorize receives an unauthenticated request

The OIDC `/authorize` endpoint is handled at the Worker layer. When a request arrives without a valid
session, it redirects to the SPA sign-in page as follows, and after sign-in the session comes back and
the OIDC flow resumes:

**Step 1: the Worker saves the OIDC request context**

When `/authorize` receives an unauthenticated request, it encodes the complete original query string
(`response_type`, `client_id`, `scope`, `redirect_uri`, `state`, `code_challenge`,
`code_challenge_method`, `nonce`, and so on) and stores it temporarily in OAuthFlowDO (key =
`authz:{applicationTenantId}:{authz_request_id}`, where `authz_request_id` is a random UUID, with a
10-minute TTL and single-use consumption). The Application Tenant is resolved from the validated
`client_id` before the browser cookie and is fixed for the complete transaction. The Durable Object
holds the protocol recovery context and the interaction start time; it never lets an identifier,
cookie, or Organization hint replace the Application-owner Tenant.

**Step 2: the Worker returns a 302 to the SPA sign-in route**

```
HTTP/1.1 302 Found
Location: /sign-in?authz_request_id=<uuid>&client_id=<client_id>&organization_id=<application_tenant_id>
```

The full OIDC parameters are not appended to the redirect URL, which keeps sensitive parameters such
as `redirect_uri` out of browser history and referrers.

**Step 3: the SPA sign-in page renders and authenticates**

The SPA `/sign-in` route reads the opaque request id plus the validated Application hints and calls
`GET /auth/config`. Every credential method carries those hints back to Core, where `client_id` is
resolved again and must agree with the Tenant hint. The user completes authentication (magic link,
email OTP, password, passkey, SSO, and so on), and the Worker issues a session cookie
(`HttpOnly; Secure; SameSite=Lax`) in the Application Tenant.

**Step 4: after sign-in the SPA returns to /authorize**

On a successful sign-in, the SPA reads the current `authz_request_id` and navigates to:

```
/authorize?authz_request_id=<uuid>&client_id=<client_id>
```

When the Worker `/authorize` endpoint receives an `authz_request_id` parameter, it restores the
original OIDC request parameters from OAuthFlowDO (single-use consumption: the Durable Object record
is deleted on restore), verifies the session cookie, and continues with the normal authorization code
issuance flow (PKCE validation, consent check, code issuance, 302 to redirect_uri).

For `prompt=login`, the interaction start time is retained with the pending request. Resume is allowed
only when the new session's `authenticated_at` is at or after that time; Core then removes the
already-satisfied `login` prompt before reevaluation. This prevents both silent prompt bypass and an
infinite `/authorize` -> `/sign-in` loop.

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

### Integration model boundary

XID currently ships redirect-hosted authentication only. A developer application begins at
`/authorize`; the complete credential interaction then stays inside the Core Worker and Hosted UI
until Core redirects the authorization code to the exact registered application callback. SDK
components may render branded redirect controls, but they MUST NOT iframe Hosted UI or claim
`hash`/`path` embedded routing. Core deliberately emits `frame-ancestors 'self'`, and WebAuthn is not
offered through a cross-origin frame.

A future truly embeddable form surface would require an explicit trusted-origin model, WebAuthn
cross-origin design, isolated credential APIs, and dedicated threat review. It is not represented by
relaxing CSP or by pointing an iframe at `/sign-in`.

### Branding customization tiers

- Hosted pages: dashboard configuration (colors and logo); arbitrary CSS is not supported
- Embedded components: the appearance prop plus a theme (including shadcn themes), with variable
  overrides and CSS class names
- Fully custom: build your own UI with the hooks

## 6. Backend SDK

Runtimes: Node (express/fastify/nextjs), Cloudflare Workers/Pages (networkless), Vercel Edge, Bun, and
Deno. Built on standard V8 web APIs.

Token and session verification:

- `authenticateRequest(request, options)`: checks `Authorization: Bearer`, or an application-owned
  short-lived JWT cookie only when `jwtCookieName` is explicit, then verifies signature, exp, and azp
- `sessionTokenExchange`: for same-origin framework deployments, forwards the incoming Cookie header
  only to an exact same-origin Core `POST /v1/sessions/token` endpoint and verifies the returned JWT;
  it never validates `__Host-xid.rt.*` locally
- `verifyToken(token, options)`: the low-level call; passing jwtKey skips the network request
- `verifyWebhook(request, options)`: HMAC signature verification

This request-authentication contract is shared by `@xid-kit/backend` and the native server SDKs in
`sdk/{go,rust,python,ruby,php,java,dotnet}`:

1. `Authorization: Bearer` is the only default credential source. Cookie fallback is disabled until
   the application explicitly supplies the name of its own short-lived JWT cookie.
2. `__Host-xid.rt.*` values are Core-owned opaque refresh credentials. An SDK never scans that
   prefix, parses one as a JWT, or silently treats a legacy `__session` cookie as an access token.
3. Core browser-session exchange is a separate, explicit operation. The caller supplies the
   absolute incoming request URL, the complete incoming `Cookie` header, and the Core endpoint. The
   SDK requires the endpoint to have the exact same origin as the incoming request and the exact
   `/v1/sessions/token` path, with no userinfo, query, or fragment.
4. The exchange sends `POST`, forwards the complete `Cookie` header only to that validated endpoint,
   never follows a redirect, and accepts only HTTP 200 JSON whose complete object shape is
   `{ "token": "<non-empty JWT>" }`. Cross-origin endpoints, redirects, malformed JSON, extra
   response fields, and empty or non-string tokens fail closed before JWT verification.
5. A runtime that does not own an HTTP client may accept an injected transport adapter, but the SDK,
   not the adapter, still enforces origin, endpoint, redirect, status, and response-shape checks.

Networkless mode: pass `jwtKey` (the JWKS public key) and no API request is needed, which suits edge
cold starts. This applies to Bearer or application JWT handoffs. A Core browser session requires the
one same-origin cookie-to-JWT exchange first. If Core and the application do not share an origin, the
application must establish an explicit Bearer/JWT handoff; it MUST NOT copy or forward Core opaque
refresh cookies across origins.

## 7. Management API (REST)

The table below is the current implemented surface, not a roadmap:

| Resource             | Operations                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| users                | CRUD, search, ban/unban, bulk metadata, export, soft delete, and restore                       |
| organizations        | CRUD, logo, domain verification, branding and policy, nested enterprise resources, and restore |
| memberships          | list/create/update role/delete/restore                                                         |
| invitations          | create (bulk rate-limited), revoke, list                                                       |
| sessions             | list/get/revoke/revoke all                                                                     |
| applications/clients | CRUD, secret rotate, delete, and restore                                                       |
| connections (SSO)    | CRUD, delete, and restore                                                                      |
| directories (SCIM)   | CRUD, token rotate, delete, and restore                                                        |
| projects             | CRUD, soft delete, restore, and active/deleted/all listing                                     |
| roles/permissions    | CRUD, delete, and restore                                                                      |
| role-permissions     | list/create/update/delete with same-Project and ABAC validation                                |
| manager-assignments  | tenant-scoped list/provision/revoke; instance managers use the separate platform path          |
| project-grants       | list/get/create/revoke/delete                                                                  |
| user-grants          | list/get/create/reactivate/revoke/delete                                                       |
| webhooks             | CRUD, delete, and restore                                                                      |
| apiKeys              | create/list/revoke                                                                             |

Authentication uses `Authorization: Bearer sk_live_xxx` or `sk_test_xxx`. M2M clients use
`client_credentials` at the root token endpoint, `POST /token`; there is no `/oauth/token` route.
Pagination is cursor-only through `{ data, next_cursor, has_more }`, with a maximum and default page
size of 100. Bulk invitations are limited to 50 per hour through `RATE_LIMITER`. The design target
of 10 metadata PATCH requests per 10 seconds per user is not implemented and MUST NOT be claimed.
Versioning uses the `/v1/` URL prefix.

The Project resources also support same-origin Console cookie sessions through exact
ManagerAssignment boundaries. `project_manager` can mutate only its assigned Project.
`project_grant_manager` can read only its exact active Grant and granted Role/Permission definitions,
and can manage UserGrants only under that Grant. The recipient Organization owner/admin has the same
UserGrant assignment boundary for its own active members. These paths do not promote either Project
manager role to Organization Admin.

Project deletion is a reversible control-plane operation. `projects.status = deleted` makes the
Project unavailable to every Project-linked client lookup, including authorization, token refresh,
client credentials, userinfo, CIBA, consent display, Role/Permission management, and grant mutation,
while preserving dependent rows. `POST /v1/projects/:id/restore` re-enables the same
namespace. `GET /v1/projects` defaults to `status=active` and accepts `deleted` or `all` so the
Console recycle view survives navigation and refresh.

Role and Permission lists use the same recycle contract: `status=active|deleted|all`, defaulting to
`active`, and return `status` plus `deleted_at`. Cookie-session reads still require the exact
`project_id` and Project authorization boundary.

ManagerAssignment provisioning is explicit. Tenant roles use `/v1/manager-assignments`; only the
fixed pairs `org_manager`/`org`, `project_manager`/`project`, and
`project_grant_manager`/`grant` are accepted. The cookie-only
`/v1/platform/manager-assignments` path owns `instance_manager` provisioning and remains separate
from tenant-scoped APIs.

The following remain explicit design targets and do not have tenant-scoped Management API
resources: `emailAddresses`, `phoneNumbers`, `allowlistIdentifiers`, `oauthApplications`,
`redirectUrls`, and billing CRUD. User impersonation is intentionally not a tenant-scoped
Management API resource; it is an implemented Instance Manager platform operation using
`POST /v1/platform/impersonation/start` and the cookie handoff lifecycle at
`POST /auth/impersonation/{handoff,consume,end}`. The read-only platform billing overview is a
separate `/v1/platform/*` console surface, not billing CRUD.

## 8. Webhooks and the event system

### Event naming `<object>.<action>` (following WorkOS's fine granularity, which has high audit value)

The list below is the design target catalog, not the shipped event list. The exact currently emitted
names are maintained in `webhook-event-contract`; the Nimbus public page lists only those names.

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
- Manual replay by message or time range is a design target and is not implemented. Queue-level
  dead-letter replay is an Instance Manager operational surface, not product-level webhook replay.
- Signature verification: the `{ type, data }` body is signed with HMAC-SHA256 and carries
  `svix-id`, `svix-timestamp`, and `svix-signature` headers, using a 5-minute replay window.
- Idempotency: developers handle duplicate events themselves
- Delivery goes through Cloudflare Queues for decoupling and never blocks the sign-in path
- The ordered, pull-based Events API remains a design target and is not implemented.

## 9. Other developer experience items

- API keys are a first-class resource with scoped permissions, managed from the frontend through
  `useAPIKeys` and through backend CRUD
- Structured errors: XidAPIError (code/message/longMessage/meta.paramName), mapping precisely onto
  form fields
- Local development: a dev instance with `sk_test_` Management API keys, OAuth `client_id` values
  for public clients, certificate-free localhost (through an HTTPS proxy), and testing tokens that
  bypass bot detection
- Documentation target: publish a dedicated page per component and hook, with a props table,
  examples, a playground, and shadcn/Tailwind integration examples. The current Nimbus Site
  publishes the product and protocol documentation corpus; the component showcase remains a design
  target.

## 10. Guest sign-in (anonymous)

The design contract is chapter 01 section 8. Status: implemented (endpoint, conversion routing,
GuestStore DO, GC cron, React and native SDK APIs); the per-platform status lives in
`docs/sdks/platform-matrix.md`.

- Endpoint: `POST /auth/guest`, an unauthenticated private extension (not a standard OIDC
  capability). It creates the anonymous user plus session, sets the HttpOnly session cookie, and
  returns exactly `{ sessionId, redirectUrl }`. The response does not embed a User, Organization, or
  expiry object; the client follows `redirectUrl` and obtains current user and organization state
  from `/v1/me`. A request that already carries a valid guest session gets a 200 response with the
  same wire shape and no new user. The endpoint is guarded by Turnstile plus RateLimitStore and a
  per-tenant daily mint cap; chapter 01 section 8 holds the full four-layer anti-duplicate contract.
- SDK API: `signInAnonymously()` creates a guest, or lazily reuses the local guest credential when
  one is still valid (the SDK does not call the endpoint in that case, the Firebase semantics).
  `isAnonymous` reflects whether the current token `amr` carries `guest`. Upgrade guidance keeps
  prompting the user to convert. Credential linking and pending Email verification convert the
  guest in place, so the next token keeps the same `sub`. Email uniqueness is Tenant-local: an
  account with the same Email in another Tenant remains independent, onboarding never performs a
  cross-Tenant merge, and a same-Tenant collision is not a normal branch for the fresh Tenant.
- Management API: the `/v1/users` list supports the `?provisioned_by=anonymous` filter; no new
  endpoint is added.
- Audit and webhook event names (see section 8): `guest.created`, `guest.converted`, and
  `guest.gc_deleted`.

## 11. SDK distribution boundary

Status: the TypeScript release graph can produce and consume audited `0.1.0-alpha.0` tarballs, but
no npm publication has been performed or authorized. Registry availability is therefore
`UNKNOWN`, not supported.

- The public graph is the 15 SDK packages plus `@xid-kit/types`, `@xid-kit/crypto`, and
  `@xid-kit/protocol`. Those kernels are public release dependencies because emitted SDK runtime or
  declaration files import them. A public artifact must never depend on a private workspace-only
  package.
- Source manifests use `workspace:^`; packed manifests must contain concrete
  `^0.1.0-alpha.0` ranges and no `workspace:` or `catalog:` protocol.
- `pnpm run sdk:distribution:verify` is the release artifact gate. It builds with `vp pack`, creates
  and audits all tarballs, and installs them into a fresh out-of-workspace consumer for TypeScript
  and runtime import checks. It never publishes or reads registry credentials.
- The 13 native SDKs remain source-only. Their manifests and README distribution claims have a
  static gate, while actual registry publication, package-name ownership, signing, provenance, and
  per-platform release automation remain external `UNKNOWN` work.

The complete package graph, gate behavior, and manual tarball command are documented in
`docs/sdks/distribution.md`.
