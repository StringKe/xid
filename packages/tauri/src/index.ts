// Tauri v2 WebView 桥 + OS keychain；与 platform-matrix Shared native contract 对齐。
// Rust 插件参考 templates/xid-keychain-plugin.rs；并 re-export @xid-kit/core 以便单入口导入。

export const PACKAGE = '@xid-kit/tauri'

export { createXidTauriClient } from './client'

export { createMemoryKeychainAdapter, createTauriKeychainAdapter } from './keychain'
export type { XidKeychainAdapter, TauriInvokeFn, TauriKeychainAdapterOptions } from './keychain'

export type {
  XidTauriClientOptions,
  SignInOptions,
  TauriSession,
  StoredSession,
  XidTauriClient,
} from './types'

export { generatePkce, deriveS256Challenge, generateBase64UrlRandom } from './pkce'
export type { PkceChallenge } from './pkce'

export { TauriTokenError } from './token-exchange'

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
