// @xid-kit/tauri: XID identity SDK for Tauri v2 desktop apps.
// Provides the JS bridge (WebView side) and OS keychain adapter for sign-in,
// authorization-code token exchange and session storage.
// Rust side: see templates/xid-keychain-plugin.rs for the plugin reference.
//
// Public API follows the "Shared native contract" from docs/sdks/platform-matrix.md:
//   signIn / handleRedirect / getSession / getAccessToken / signOut / setTokenStorage

export const PACKAGE = '@xid-kit/tauri'

// Primary client factory
export { createXidTauriClient } from './client'

// Keychain adapters
export { createMemoryKeychainAdapter, createTauriKeychainAdapter } from './keychain'
export type { XidKeychainAdapter, TauriInvokeFn, TauriKeychainAdapterOptions } from './keychain'

// Public types
export type {
  XidTauriClientOptions,
  SignInOptions,
  TauriSession,
  StoredSession,
  XidTauriClient,
} from './types'

// PKCE utilities (advanced use: host app may need to call deriveS256Challenge independently)
export { generatePkce, deriveS256Challenge, generateBase64UrlRandom } from './pkce'
export type { PkceChallenge } from './pkce'

// Error type
export { TauriTokenError } from './token-exchange'

// Re-export full @xid-kit/core public API so callers need only one import.
export {
  XidClient,
  XidStore,
  TokenManager,
  XidApiClient,
  XidNetworkError,
  makeXidError,
  isXidErrorShape,
  decodeTokenClaims,
  isTokenExpiring,
  SESSION_STATUS,
  CLIENT_STATUS,
} from '@xid-kit/core'

export type {
  TokenResponse,
  ClientStateResponse,
  DecodedTokenClaims,
  XidUser,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  XidApiKey,
  XidApiKeyWithSecret,
  XidPage,
  CreateApiKeyInput,
  SignInPasswordInput,
  SignInResult,
  SessionStatus,
  ClientStatus,
  XidState,
  XidStateListener,
  Unsubscribe,
  GetTokenOptions,
  XidClientOptions,
} from '@xid-kit/core'

export type { OrganizationMembershipRole } from '@xid-kit/types'
