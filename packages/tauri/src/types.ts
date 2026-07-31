// Public type contracts for @xid-kit/tauri.
// Shared native contract from docs/sdks/platform-matrix.md:
//   configure / signIn / handleRedirect / getSession / getAccessToken / signOut / setTokenStorage

import type { XidKeychainAdapter } from './keychain'

// Minimal session view stored in OS keychain (no PII beyond userId / orgId).
export type StoredSession = {
  userId: string
  organizationId: string | null
  expiresAt: number // epoch seconds
  abandonAt: number // epoch seconds
}

// Options passed to createXidTauriClient().
export type XidTauriClientOptions = {
  // XID issuer URL, e.g. "https://xid.dev" or self-hosted root.
  issuer: string
  // OAuth 2.0 client_id registered in the XID console.
  clientId: string
  // Custom URI scheme registered in tauri.conf.json, e.g. "myapp://auth/callback".
  redirectUri: string
  // OAuth scopes. Default: ["openid", "profile", "email"].
  scopes?: readonly string[]
  // Token/session persistence adapter. Default: MemoryKeychainAdapter.
  keychain?: XidKeychainAdapter
  // Inject fetch for testing. Default: globalThis.fetch.
  fetcher?: typeof fetch
  // Inject clock (epoch seconds) for testing. Default: Math.floor(Date.now()/1000).
  now?: () => number
}

// Per-call options for signIn().
export type SignInOptions = {
  scopes?: readonly string[]
  // Pre-open the URL using shell.open() instead of returning it.
  // Pass a shell-open function from @tauri-apps/plugin-shell when using this option.
  openUrl?: (url: string) => Promise<void>
}

// Result returned by getSession().
export type TauriSession = {
  userId: string
  organizationId: string | null
  // Access token JWT. Reauthorize after expiry.
  accessToken: string
  expiresAt: number // epoch seconds
}

// The public API surface of the Tauri client.
// Matches the "Shared native contract" from platform-matrix.md.
export type XidTauriClient = {
  // Build the PKCE authorization URL (and optionally open it via openUrl callback).
  // Returns the URL regardless of whether openUrl was called.
  signIn(options?: SignInOptions): Promise<URL>

  // Call from your deeplink handler (onOpenUrl / listen("deep-link://new-url")).
  // Exchanges the authorization code and persists tokens to the keychain.
  handleRedirect(url: string): Promise<void>

  // Retrieve the active unexpired session.
  // Returns null if not signed in.
  getSession(): Promise<TauriSession | null>

  // Retrieve the current access token string (null if signed out).
  // Returns null when the token is expired and reauthorization is required.
  getAccessToken(options?: { skipCache?: boolean }): Promise<string | null>

  // Sign out by clearing all local keychain entries.
  signOut(): Promise<void>

  // Build the OIDC RP-initiated logout URL (for post-sign-out redirect).
  buildSignOutUrl(options?: { postLogoutRedirectUri?: string; idTokenHint?: string }): URL

  // Replace the token storage adapter at runtime.
  setTokenStorage(adapter: XidKeychainAdapter): void
}
