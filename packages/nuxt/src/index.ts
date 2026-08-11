export { defineXidModule, setupXidModule, moduleMetadata } from './module'
export type { XidNuxtBrowserOptions, XidNuxtModuleOptions } from './types'

export { default } from './module'

export { createXidServerMiddleware, getXidAuth } from './server-middleware'
export type { XidServerMiddlewareOptions } from './server-middleware'

export type { AuthResult, AuthObject, UnauthenticatedAuthObject } from './types'
export { XID_AUTH_CONTEXT_KEY } from './types'

// module 已注册 auto-import；此处命名导出供显式 import 使用。
export { useXid, useAuth, useUser, useOrganization, useSession } from '@xid-kit/vue'

export type {
  UseXidReturn,
  UseAuthReturn,
  UseUserReturn,
  UseOrganizationReturn,
  UseSessionReturn,
} from '@xid-kit/vue'

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

export { createXidClient } from '@xid-kit/vue'

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
