// Vue 3 SDK：只做响应式接线，协议逻辑复用 @xid-kit/core。

export { XidPlugin, createXidClient, useXidClient, XID_INJECTION_KEY } from './plugin'
export type { XidPluginOptions } from './plugin'

export { useXid } from './composables/use-xid'
export type { UseXidReturn } from './composables/use-xid'

export { useAuth } from './composables/use-auth'
export type { UseAuthReturn } from './composables/use-auth'

export { useUser } from './composables/use-user'
export type { UseUserReturn } from './composables/use-user'

export { useOrganization } from './composables/use-organization'
export type { UseOrganizationReturn } from './composables/use-organization'

export { useSession } from './composables/use-session'
export type { UseSessionReturn } from './composables/use-session'

export { SignInButton } from './components/sign-in-button'
export type { SignInButtonProps } from './components/sign-in-button'

export { SignOutButton } from './components/sign-out-button'
export type { SignOutButtonProps } from './components/sign-out-button'

export { Protect } from './components/protect'
export type { ProtectProps } from './components/protect'

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
  PACKAGE,
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
