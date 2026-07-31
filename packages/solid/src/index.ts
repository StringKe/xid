// @xid-kit/solid: SolidJS integration for the XID identity platform.
// Provides context injection, reactive signal primitives, and headless components.
// Wraps @xid-kit/core; all protocol and token logic lives in core.

// --- Provider & context ---
export { XidProvider } from './provider'
export type { XidProviderProps } from './provider'

export { XidContext, useXidContext } from './context'
export type { XidContextValue } from './context'

// --- Reactive primitives ---
export { createAuth, createUser, createOrganization, createSession } from './primitives'
export type {
  CreateAuthReturn,
  CreateUserReturn,
  CreateUserAccessor,
  CreateOrganizationReturn,
  CreateOrganizationAccessor,
  CreateSessionReturn,
  CreateSessionAccessor,
} from './primitives'

// --- Prebuilt headless components ---
export { SignInButton, SignOutButton, Protect } from './components'
export type { SignInButtonProps, SignOutButtonProps, ProtectProps } from './components'

// --- @xid-kit/core re-exports (public surface) ---
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

export const SOLID_PACKAGE = '@xid-kit/solid' as const
