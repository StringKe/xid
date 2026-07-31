# SDK Platform Matrix

Chinese version: [../zh-Hans/sdks/platform-matrix.md](../zh-Hans/sdks/platform-matrix.md)

This document answers one question: does XID have an SDK for the language, framework or platform you are about to use, and how mature is it. The reader is a developer evaluating XID or preparing an integration.

The coverage target is the mainstream server runtimes and languages, plus client-side web frameworks, mobile and desktop. Maturity varies a lot. Every row below carries a status, so judge by the status, not by the mere presence of a row.

## Distribution

- The 15 public TypeScript SDKs and their three required runtime kernels (`types`, `crypto`, and
  `protocol`) produce audited `0.1.0-alpha.0` npm tarballs. **No npm publish has been performed or
  authorized.** `pnpm run sdk:distribution:verify` builds with `vp pack`, audits every tarball, and
  installs representative tarball dependency closures into fresh consumers for strict type,
  runtime, browser, Worker, and native peer-resolution checks. See
  [distribution.md](distribution.md).
- The 13 native SDKs under `sdk/` (go, java, rust, php, ruby, python, dotnet, ios, android, macos,
  windows, linux, flutter) are **not published to any registry**: not crates.io, PyPI, Maven Central,
  RubyGems, Packagist, NuGet, CocoaPods, Swift Package Registry or pub.dev. They ship as source.
  `pnpm native:verify` checks every directory, package manifest, package-format metadata, and honest
  source-only README wording. Native language test suites remain a local opt-in
  (`XID_NATIVE_SDK_PLATFORM=go pnpm native:verify`); see [../deployment.md](../deployment.md).

## Status vocabulary

- `current package`: the repository has the package, source, test entry point, workspace
  configuration, and a locally verified release artifact. It does not imply registry publication.
- `implemented`: the toolchain compiles and every unit test is PASS. **The real-IdP round trip (L4) is not verified, so do not treat it as a complete production SDK.**
- `scaffold`: the repository has a starting skeleton with a minimal package, types, README or sample. **It is not a complete production SDK.** The source exists but the tests have not been validated. Before production use it must compile in the real toolchain and be verified against a real IdP round trip.
- `planned design`: only the platform design and integration flow exist, with no code skeleton in the repository. (Every platform is currently at least scaffold; this status is reserved for platforms added in future.)

## Server matrix

Server SDKs perform networkless JWT verification, request authentication and webhook verification. They never store a client secret in a public client. Web-standard runtimes (Workers, Node, Bun, Deno) share `@xid-kit/backend` (Web Crypto); other languages use their own native SDK under `sdk/<lang>`.

| Runtime / language | Package or directory | Status          | Test coverage                                | Responsibilities                                     |
| ------------------ | -------------------- | --------------- | -------------------------------------------- | ---------------------------------------------------- |
| Cloudflare Workers | `@xid-kit/backend`   | current package | exports plus verify unit tests               | Networkless JWT verify, request auth, webhook verify |
| Node.js            | `@xid-kit/backend`   | current package | Same as above                                | Same as above (web-standard runtime, Web Crypto)     |
| Bun                | `@xid-kit/backend`   | current package | Same as above                                | Same as above (web-standard runtime)                 |
| Deno               | `@xid-kit/backend`   | current package | Same as above                                | Same as above (web-standard runtime)                 |
| Go                 | `sdk/go`             | implemented     | `go test ./...`                              | Native JWT verify, request auth, webhook verify      |
| Java               | `sdk/java`           | implemented     | main() self-test (JDK 25, zero dependencies) | Native JWT verify, request auth, webhook verify      |
| Rust               | `sdk/rust`           | implemented     | `cargo test`                                 | Native JWT verify, request auth, webhook verify      |
| PHP                | `sdk/php`            | implemented     | `run-tests.php` plus PHPUnit                 | Native JWT verify, request auth, webhook verify      |
| Ruby               | `sdk/ruby`           | implemented     | minitest (Ruby 2.6, zero dependencies)       | Native JWT verify, request auth, webhook verify      |
| Python             | `sdk/python`         | implemented     | pytest (Python 3.14, PyJWT + cryptography)   | Native JWT verify, request auth, webhook verify      |
| .NET               | `sdk/dotnet`         | implemented     | `dotnet test` (net8.0 + net9.0)              | Native JWT verify, request auth, webhook verify      |

### Server gaps

- **PHP**: both PHPUnit and `run-tests.php` pass. JwksCache accepts an injected PSR-18 HTTP client.
- **Python**: the tests need `httpx`, `PyJWT`, `cryptography` and `pytest-asyncio`. Run `pip install -e ".[dev]"` and then `pytest`.
- **All server SDKs**: the L4 real-IdP round trip is not verified. Do not treat them as production-ready.

## Client matrix: web frameworks

The framework layer sits on top of `@xid-kit/core` (the browser core) and supplies providers, hooks/composables/stores and prebuilt components. Every `@xid-kit/*` framework package is a current package with a provider, hooks and type exports; the higher-level prebuilt UI components are still evolving.

| Framework          | Package or directory | Status          | Test coverage                                                          | Responsibilities                                                   |
| ------------------ | -------------------- | --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Vanilla JS / Web   | `@xid-kit/core`      | current package | -                                                                      | Browser client, session store, token cache, Management API helper  |
| React              | `@xid-kit/react`     | current package | `vp test` exports test PASS; public exports match `docs/sdks/react.md` | Provider, hooks, control components, user UI, organization UI      |
| Next.js            | `@xid-kit/nextjs`    | current package | -                                                                      | Middleware, App Router helper, Pages Router helper, server auth    |
| Vue                | `@xid-kit/vue`       | current package | -                                                                      | Plugin, composables, prebuilt components                           |
| Nuxt               | `@xid-kit/nuxt`      | current package | -                                                                      | Module, server middleware, composables                             |
| Svelte / SvelteKit | `@xid-kit/svelte`    | current package | -                                                                      | Stores, actions, prebuilt components                               |
| Angular            | `@xid-kit/angular`   | current package | -                                                                      | Provider, guards, services, components                             |
| Remix              | `@xid-kit/remix`     | implemented     | Unit tests plus check and typecheck                                    | Loader/action helpers, session integration, PKCE callback exchange |
| Astro              | `@xid-kit/astro`     | current package | -                                                                      | Integration, middleware, island components                         |
| SolidJS            | `@xid-kit/solid`     | current package | -                                                                      | Provider, primitives, components                                   |

The Remix callback exchanges authorization codes at the Core root `POST /token` endpoint. Its
hosted default is `https://xid.dev/token`; self-hosted instances override `tokenEndpoint` with their
issuer's `/token` URL. Unit tests cover both URL branches, PKCE, state, session persistence, error
handling, and redirect safety. A real-IdP L4 round trip remains unverified.

## Client matrix: mobile

| Platform         | Package or directory    | Status      | Test coverage                                                     | Responsibilities                                                                                |
| ---------------- | ----------------------- | ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| React Native     | `@xid-kit/react-native` | implemented | Unit tests, typecheck and package build                           | Hosted redirect, state + nonce PKCE, JWKS verify, authorization-code-only native session        |
| Expo             | `@xid-kit/expo`         | implemented | Unit tests and typecheck                                          | React Native authorization-code session plus SecureStore, WebBrowser and Expo Router adapters   |
| Flutter          | `sdk/flutter`           | implemented | `flutter test`                                                    | Hosted redirect, state + nonce PKCE, secure storage adapter, native-backend ES256 verify        |
| iOS (Swift)      | `sdk/ios`               | implemented | `swift test` (compiled on macOS; the Keychain runner needs Xcode) | ASWebAuthenticationSession, Keychain, state + nonce PKCE, JWKS verify and refresh single-flight |
| Android (Kotlin) | `sdk/android`           | implemented | `gradle testDebugUnitTest` (JVM unit tests)                       | Custom Tabs, state + nonce PKCE, JWKS verify, RP-initiated logout and Keystore storage          |

`@xid-kit/react-native` and `@xid-kit/expo` require React 19 but do not reuse the web-cookie
runtime from `@xid-kit/react` or `@xid-kit/core`. Native-only consumers do not install
`react-dom`.

### Mobile gaps

- **iOS**: the tests run on the macOS platform. `ASWebAuthenticationSession`, `UIApplication` and real Keychain behaviour need an iOS simulator or a device. `KeychainTokenStorageTests` depends on a Keychain entitlement, so its result has to be confirmed inside Xcode.
- **Android**: JVM unit tests only (PKCE, State and InMemoryStorage). `EncryptedSharedPreferences` (Keystore AES-256-GCM), the `CustomTabs` browser session and the App Links callback all need an Android device or emulator. `testInstrumentationRunner` has not been run.
- **React Native / Expo**: TokenCache and BrowserInterface are injected adapters. Real SecureStore,
  Keychain, EncryptedSharedPreferences, deep links and the real-IdP round trip need a device or
  emulator. One local account per storage namespace is supported; organization management hooks
  and native organization UI are not implemented. These SDKs do not implement DPoP, reject
  `offline_access`, and require reauthorization after access-token expiry.
- **Flutter**: unit tests cover the state/nonce claims chain and session logic, but not the real
  `flutter_secure_storage`, `flutter_web_auth_2` or `cryptography_flutter` native platform channels.
  Those paths and the real-IdP round trip need a device or emulator.

## Client matrix: desktop

| Platform | Package or directory | Status          | Test coverage                                                  | Responsibilities                                                     |
| -------- | -------------------- | --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| macOS    | `sdk/macos`          | implemented     | `swift test`                                                   | ASWebAuthenticationSession, Keychain storage, PKCE S256              |
| Windows  | `sdk/windows`        | implemented     | `dotnet test` (net8.0 cross-platform build, tested on net10.0) | JWKS id token verify, end_session, nonce, WebView2, DPAPI, PKCE S256 |
| Linux    | `sdk/linux`          | implemented     | `cargo test`                                                   | System browser redirect, JWKS ID token verify, PKCE S256             |
| Electron | `@xid-kit/electron`  | current package | -                                                              | Main/renderer bridge, safeStorage, loopback/custom scheme callback   |
| Tauri    | `@xid-kit/tauri`     | current package | -                                                              | Rust backend bridge, OS keychain, PKCE S256                          |

### Desktop gaps

- **macOS**: the Keychain tests run on the local machine. The `ASWebAuthenticationSession` OAuth callback flow needs a running XID server endpoint. The L4 round trip is not verified.
- **Windows**: the `net8.0` cross-platform target compiles, and JWKS signature verification plus `/end_session` are implemented. The Windows-specific APIs (`WebView2`, `DPAPI`, `WinUI 3`) compile only under the `net8.0-windows10.0.19041.0` TFM and need a Windows build environment to verify. `DpapiTokenStorage` cannot run on a non-Windows system.
- **Linux**: the `secret-service-storage` feature is not enabled. `SecretServiceStorage` needs a `gnome-keyring` or `kwallet` D-Bus daemon. In a headless environment (CI, no desktop) it falls back to `InMemoryStorage`.
- **Electron / Tauri**: neither SDK implements DPoP. They reject `offline_access` and operate as
  authorization-code-only public clients; access-token expiry requires a new sign-in.

## Shared native contract

All native SDKs use Hosted Auth plus OIDC Authorization Code with PKCE S256. They do not implement SAML, SCIM, Management API business flows, implicit flow, password grant, or client secret storage in public clients.

JS/TS native SDKs (`@xid-kit/react-native`, `@xid-kit/expo`) use a React Provider + hooks model. Non-JS SDKs (iOS, Android, Flutter, macOS) use a configure/signIn/handleRedirect functional API.

JS/TS native common API surface (Provider props / hook returns):

```text
XidProvider props:
  issuer
  clientId
  redirectUri
  scopes
  tokenCache       (TokenCache adapter)
  browser          (BrowserInterface adapter)

useSignIn() returns:
  signIn(options?)  -> Promise<void>   (builds PKCE authorize URL, opens browser)
  handleRedirect(url) -> Promise<void> (validates CSRF state, exchanges code, stores tokens)
  signInState       (idle | pending | complete | cancelled | error)

useSignOut() returns:
  signOut()         -> Promise<void>
  signOutState      (idle | pending | complete | error)
```

Common concepts:

```text
issuer
clientId
redirectUri
scopes
codeChallengeMethod=S256
tokenCache / tokenStorage
session
user
organization
```

Public native clients may request `offline_access` only when their registration and token requests
use DPoP sender binding. A client with no DPoP proof implementation is authorization-code-only and
must reauthorize after access-token expiry. This is a server-enforced protocol boundary, not an
optional SDK optimization.

Common adapter interfaces (JS/TS):

```text
TokenCache:
  getToken(key)           -> Promise<string | null>
  saveToken(key, value)   -> Promise<void>
  deleteToken(key)        -> Promise<void>
  coordinationNamespace?  -> string

BrowserInterface:
  openAuthSession(url, redirectUri) -> Promise<BrowserResult>
```

## Capability status: guest (anonymous) sign-in

The design contract for Firebase-style guest sign-in lives in
[../design/01-authentication.md](../design/01-authentication.md) section 8, and the server endpoint
`POST /auth/guest` is tracked in [../protocols/source-map.md](../protocols/source-map.md) as
implemented (L1/L2, local tests). The capability covers `signInAnonymously()`, `isAnonymous`,
upgrade guidance, and the generic sub-comparison helper (see
[../design/06-developer-experience.md](../design/06-developer-experience.md) section 10). Statuses
below reflect shipped code with tests; rows marked not started have no guest support yet.

Hosted Auth routes both a guest and a credential sign-up with `intent=sign-up` to the server-owned
top-level Tenant onboarding flow. The guest Email stays pending until it is verified in the new
Tenant, and the verified conversion preserves `sub`. The same Email in another Tenant is an
independent tenant-local account, not an SDK merge or ownership-transfer flow. This server and
Hosted UI behavior does not change any SDK support level in the table below; the existing
sub-comparison helper remains available for application-specific identity transitions.

Every SDK that creates a guest follows the same entry-capability contract: if no local session can
be lazily reused, GET `/auth/config?intent=sign-up`, require a non-empty
`guest.capabilityToken`, then include that one-time token in POST `/auth/guest` together with the
optional `turnstileToken`. The capability is fetched per creation attempt and is never cached or
reused. A missing capability or any later failure leaves no persisted partial guest session.

| Platform surface                                                                             | Guest sign-in status                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@xid-kit/core` and `@xid-kit/react`                                                         | implemented: `signInAnonymously()`, `isAnonymous`, `isGuestUser`/`isSameUser`, `<GuestUpgradeBanner />`; other web framework packages not started                                             |
| `@xid-kit/backend` and every server native SDK (`sdk/{go,java,rust,php,ruby,python,dotnet}`) | implemented: guest detection on the verified principal (`IsGuest()` / `is_guest` / `guest?` via the `amr` claim); `signInAnonymously()` is not applicable to backend SDKs by design           |
| Mobile (`sdk/flutter`, `sdk/ios`, `sdk/android`)                                             | implemented: `signInAnonymously()` with lazy reuse, session-cookie persistence, `isAnonymous`; React Native / Expo expose `isAnonymous` from verified claims but do not create guest sessions |
| Desktop (`sdk/macos`, `sdk/windows`, `sdk/linux`)                                            | implemented: `signInAnonymously()` with lazy reuse, session-cookie persistence, `isAnonymous`; `@xid-kit/electron`, `@xid-kit/tauri` not started                                              |
