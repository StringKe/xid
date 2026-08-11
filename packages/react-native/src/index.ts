// RN SDK：TokenCache 驱动登录态，不依赖浏览器 cookie；协议与密码学不落本包。

export { XidProvider } from './xid-provider'
export type { XidProviderProps } from './xid-provider'

export { useXidRnContext } from './xid-rn-context'
export type { XidRnContextValue } from './xid-rn-context'

export type { TokenCache } from './token-cache'
export type { BrowserInterface, BrowserResult } from './browser-interface'

export { useSignIn } from './use-sign-in'
export type { UseSignInReturn, SignInOptions, SignInState } from './use-sign-in'

export { useSignOut } from './use-sign-out'
export type { UseSignOutReturn, SignOutState } from './use-sign-out'

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

export {
  createRandomString,
  createPkceVerifier,
  createPkceChallenge,
  base64UrlEncode,
} from './pkce'

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
