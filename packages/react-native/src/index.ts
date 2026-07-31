// @xid-kit/react-native:React Native SDK(对标 @clerk/clerk-expo mobile auth)。
// 架构:secure TokenCache 驱动的 RN Provider + hooks,不依赖浏览器 cookie session。
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

// --- Native token-session hooks + control components ---
export {
  useAuth,
  useUser,
  useSession,
  SignedIn,
  SignedOut,
  XidLoaded,
  XidLoading,
} from './native-auth'
export type {
  UseAuthReturn,
  UseUserReturn,
  UseSessionReturn,
  NativeUser,
  AuthControlProps,
} from './native-auth'

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
export { verifyNativeIdToken } from './id-token'
export type { NativeIdTokenClaims, VerifyNativeIdTokenInput } from './id-token'
