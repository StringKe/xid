// @xid-kit/angular：Angular 17+ 独立组件风格 SDK（无 NgModule）。

export { provideXid, XID_CLIENT } from './provider'
export type { ProvideXidOptions } from './provider'

export { XidAuthService } from './xid-auth.service'

export { authGuard, hasOrganizationGuard, hasPermissionGuard } from './guards'

export { SignInButton } from './sign-in-button.component'
export { SignOutButton } from './sign-out-button.component'

// 应用侧只需从本包导入；核心类型与客户端由 @xid-kit/core 再导出。
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
