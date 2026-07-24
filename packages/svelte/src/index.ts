// @xid-kit/svelte:Svelte / SvelteKit binding for the XID identity platform.
// 状态: current package。
// 提供:
//   - createXidStores:把 XidClient 映射为 Svelte store(auth/user/organization/session/state)。
//   - setXidContext / getXidContext:Svelte context 注入/读取。
//   - protect-logic:isAllowed 纯函数(Protect.svelte 调用)。
//   - sign-in-logic:buildSignInUrl / executeSignOut 纯函数(SignInButton/SignOutButton 调用)。
//   - server:handleXid / getXidAuth(SvelteKit hooks.server.ts + load 函数)。
// 框架层只做接线;协议逻辑全部委托 @xid-kit/core 与 @xid-kit/backend。
// peerDep: svelte >=5.0.0, @sveltejs/kit >=2.0.0(可选,仅 server helpers 依赖)。

// --- 核心 stores ---
export { createXidStores } from './stores'
export type {
  XidStores,
  Readable,
  Writable,
  AuthState,
  UserState,
  OrganizationState,
  SessionState,
  GetTokenFn,
  SignOutFn,
} from './stores'

// --- Context helpers ---
export { setXidContext, getXidContext, XID_CONTEXT_KEY } from './context'

// --- Protect 纯逻辑 ---
export { isAllowed } from './protect-logic'
export type { ProtectOptions } from './protect-logic'

// --- SignIn / SignOut 纯逻辑 ---
export { buildSignInUrl, executeSignOut } from './sign-in-logic'

// --- 内部类型(AuthResult,供 server 端 load 使用)---
export type { AuthResult, AuthObject, UnauthenticatedAuthObject } from './types'
export { XID_AUTH_HEADER } from './types'

// --- Re-export @xid-kit/core 公共 API(单一 import 点)---
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
