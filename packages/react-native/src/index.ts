// @xid-kit/react-native:React Native SDK(对标 @clerk/clerk-expo mobile auth)。
// 架构:@xid-kit/react hooks 复用(useAuth/useUser/useOrganization/useSession) +
//       RN 专属 XidProvider(注入 tokenCache + browser 适配器)+ RN 专属 hooks。
// 不重写任何协议逻辑;密码学走 Web Crypto(crypto.subtle / crypto.getRandomValues)。
// 见 docs/sdks/platform-matrix.md 移动端行 + Shared native contract 节。

// --- Provider ---
export { XidProvider } from './xid-provider'
export type { XidProviderProps } from './xid-provider'

// --- RN context(高级用法 / 测试)---
export { useXidRnContext } from './xid-rn-context'
export type { XidRnContextValue } from './xid-rn-context'

// --- 适配器抽象接口(调用方实现)---
export type { TokenCache } from './token-cache'
export type { BrowserInterface, BrowserResult } from './browser-interface'

// --- RN 专属 hooks ---
export { useSignIn } from './use-sign-in'
export type { UseSignInReturn, SignInOptions, SignInState } from './use-sign-in'

export { useSignOut } from './use-sign-out'
export type { UseSignOutReturn, SignOutState } from './use-sign-out'

// --- re-export @xid-kit/react hooks(语义完全一致,无需重写)---
export {
  useAuth,
  useUser,
  useSession,
  useSessionList,
  useOrganization,
  useOrganizationList,
  useAPIKeys,
  SignedIn,
  SignedOut,
  Protect,
  XidLoaded,
  XidLoading,
  XidFailed,
  XidDegraded,
} from '@xid-kit/react'
export type {
  UseAuthReturn,
  UseUserReturn,
  UseSessionReturn,
  UseSessionListReturn,
  UseOrganizationReturn,
  UseOrganizationListReturn,
  UseAPIKeysReturn,
  SignedInProps,
  SignedOutProps,
  ProtectProps,
  XidLoadedProps,
  XidLoadingProps,
  XidFailedProps,
  XidDegradedProps,
} from '@xid-kit/react'

// --- PKCE 工具(高级用法 / 测试)---
export {
  createRandomString,
  createPkceVerifier,
  createPkceChallenge,
  base64UrlEncode,
} from './pkce'

// --- token exchange(高级用法)---
export {
  exchangeCodeForTokens,
  saveTokenSet,
  readTokenSet,
  clearTokenSet,
  TOKEN_KEYS,
} from './token-exchange'
export type { TokenExchangeInput, TokenSet, StoredTokenSet } from './token-exchange'
export { XidSessionManager } from './session-manager'
