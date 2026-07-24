// useSignIn(RN):触发 hosted redirect 登录流程。
// 职责:构建 PKCE 授权 URL -> 打开浏览器 -> 处理 deep link 回调 -> token exchange -> 存储。
// 网络层 token 请求走 fetch(Web Crypto PKCE);存储走注入的 tokenCache。

import { useCallback, useState } from 'react'

import { useXidRnContext } from './xid-rn-context'
import { createPkceVerifier, createPkceChallenge, createRandomString } from './pkce'
import { exchangeCodeForTokens, pendingAuthorizationKey, saveTokenSet } from './token-exchange'
import type { TokenCache } from './token-cache'

const pendingAuthorizationTails = new Map<string, Promise<void>>()
const tokenCacheNamespaces = new WeakMap<TokenCache, string>()
let nextTokenCacheNamespace = 0

export type SignInOptions = {
  redirectUri?: string
  scopes?: readonly string[]
}

export type SignInState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'complete' }
  | { status: 'cancelled' }
  | { status: 'error'; error: Error }

export type UseSignInReturn = {
  signInState: SignInState
  signIn: (options?: SignInOptions) => Promise<void>
  handleRedirect: (url: string) => Promise<void>
}

// Parses the callback URL, validates CSRF state, exchanges code for tokens.
// Extracted as module-level function to avoid unstable closure in useCallback deps.
async function processCallback(input: {
  url: string
  redirectUri: string
  tokenCache: TokenCache
  issuer: string
  clientId: string
}): Promise<void> {
  const callbackUrl = new URL(input.url)
  const code = callbackUrl.searchParams.get('code')
  const returnedState = callbackUrl.searchParams.get('state')
  if (!returnedState) {
    throw new Error('[xid-kit/react-native] Redirect state mismatch (CSRF guard).')
  }

  const verifier = await consumePendingAuthorization(input.tokenCache, returnedState)
  const error = callbackUrl.searchParams.get('error')
  if (error) {
    throw new Error(`[xid-kit/react-native] OAuth error: ${error}`)
  }
  if (!code) {
    throw new Error('[xid-kit/react-native] Redirect is missing authorization code.')
  }

  const tokens = await exchangeCodeForTokens({
    issuer: input.issuer,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    code,
    verifier,
  })
  await saveTokenSet(input.tokenCache, tokens)
}

async function consumePendingAuthorization(cache: TokenCache, state: string): Promise<string> {
  const namespace = tokenCacheNamespace(cache)
  const previous = pendingAuthorizationTails.get(namespace) ?? Promise.resolve()
  let release: () => void = () => undefined
  const tail = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  pendingAuthorizationTails.set(namespace, tail)

  await previous
  try {
    const key = pendingAuthorizationKey(state)
    const verifier = await cache.getToken(key)
    if (!verifier) {
      throw new Error('[xid-kit/react-native] PKCE verifier missing from token cache.')
    }
    await cache.deleteToken(key)
    return verifier
  } finally {
    release()
    if (pendingAuthorizationTails.get(namespace) === tail) {
      pendingAuthorizationTails.delete(namespace)
    }
  }
}

function tokenCacheNamespace(cache: TokenCache): string {
  if (cache.coordinationNamespace) return cache.coordinationNamespace

  const existing = tokenCacheNamespaces.get(cache)
  if (existing) return existing

  const namespace = `token-cache:${nextTokenCacheNamespace}`
  nextTokenCacheNamespace += 1
  tokenCacheNamespaces.set(cache, namespace)
  return namespace
}

export function useSignIn(): UseSignInReturn {
  const {
    tokenCache,
    browser,
    issuer,
    clientId,
    redirectUri: defaultRedirectUri,
    scopes: defaultScopes,
    restoreSession,
  } = useXidRnContext()
  const [signInState, setSignInState] = useState<SignInState>({ status: 'idle' })

  const signIn = useCallback(
    async (options: SignInOptions = {}): Promise<void> => {
      setSignInState({ status: 'pending' })

      let pendingKey: string | null = null
      try {
        const redirectUri = options.redirectUri ?? defaultRedirectUri
        const scopes = options.scopes ?? defaultScopes

        // All PKCE + tokenCache + browser calls inside try: any failure -> error state.
        const verifier = createPkceVerifier(64)
        const state = createRandomString(32)
        const challenge = await createPkceChallenge(verifier)

        const authorizeUrl = new URL('/authorize', issuer)
        authorizeUrl.searchParams.set('client_id', clientId)
        authorizeUrl.searchParams.set('redirect_uri', redirectUri)
        authorizeUrl.searchParams.set('response_type', 'code')
        authorizeUrl.searchParams.set('scope', scopes.join(' '))
        authorizeUrl.searchParams.set('state', state)
        authorizeUrl.searchParams.set('code_challenge', challenge)
        authorizeUrl.searchParams.set('code_challenge_method', 'S256')

        pendingKey = pendingAuthorizationKey(state)
        await tokenCache.saveToken(pendingKey, verifier)

        const result = await browser.openAuthSession(authorizeUrl.toString(), redirectUri)

        if (result.type === 'cancel' || result.type === 'dismiss') {
          await tokenCache.deleteToken(pendingKey)
          setSignInState({ status: 'cancelled' })
          return
        }

        await processCallback({
          url: result.url,
          redirectUri,
          tokenCache,
          issuer,
          clientId,
        })
        await restoreSession()
        setSignInState({ status: 'complete' })
      } catch (err) {
        if (pendingKey) {
          await tokenCache.deleteToken(pendingKey)
        }
        setSignInState({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    },
    [tokenCache, browser, issuer, clientId, defaultRedirectUri, defaultScopes, restoreSession],
  )

  const handleRedirect = useCallback(
    async (url: string): Promise<void> => {
      try {
        await processCallback({
          url,
          redirectUri: defaultRedirectUri,
          tokenCache,
          issuer,
          clientId,
        })
        await restoreSession()
        setSignInState({ status: 'complete' })
      } catch (err) {
        setSignInState({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    },
    [tokenCache, issuer, clientId, defaultRedirectUri, restoreSession],
  )

  return { signInState, signIn, handleRedirect }
}
