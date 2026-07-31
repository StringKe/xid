// @xid-kit/angular: Angular 17+ SDK for the XID identity platform.
// Angular standalone style (no NgModule). Requires @angular/core >=17.0.0.
//
// Quick start (app.config.ts):
//   import { provideXid } from '@xid-kit/angular'
//   export const appConfig: ApplicationConfig = {
//     providers: [provideXid({ mode: 'same-origin' })]
//   }

// --- Provider / DI ---
export { provideXid, XID_CLIENT } from './provider'
export type { ProvideXidOptions } from './provider'

// --- Injectable service ---
export { XidAuthService } from './xid-auth.service'

// --- Route guards (CanActivateFn factories) ---
export { authGuard, hasOrganizationGuard, hasPermissionGuard } from './guards'

// --- Standalone components ---
export { SignInButton } from './sign-in-button.component'
export { SignOutButton } from './sign-out-button.component'

// --- @xid-kit/core re-exports ---
// Angular apps only need to import from @xid-kit/angular.
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
