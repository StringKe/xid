import { useCallback, useState } from 'react'

import { useXidRnContext } from './xid-rn-context'
import { createPkceVerifier, createPkceChallenge, createRandomString } from './pkce'
import { exchangeCodeForTokens, pendingAuthorizationKey } from './token-exchange'
import type { TokenSet } from './token-exchange'
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

type PendingAuthorization = {
  verifier: string
  nonce: string
  redirectUri: string
}

// 模块级函数，避免 processCallback 进入 useCallback 依赖导致闭包不稳定。
async function processCallback(input: {
  url: string
  tokenCache: TokenCache
  issuer: string
  clientId: string
  fetcher: typeof fetch
}): Promise<TokenSet> {
  const callbackUrl = new URL(input.url)
  const code = callbackUrl.searchParams.get('code')
  const returnedState = callbackUrl.searchParams.get('state')
  if (!returnedState) {
    throw new Error('[xid-kit/react-native] Redirect state mismatch (CSRF guard).')
  }

  const pending = await consumePendingAuthorization(input.tokenCache, returnedState)
  const error = callbackUrl.searchParams.get('error')
  if (error) {
    throw new Error(`[xid-kit/react-native] OAuth error: ${error}`)
  }
  if (!code) {
    throw new Error('[xid-kit/react-native] Redirect is missing authorization code.')
  }

  return exchangeCodeForTokens({
    issuer: input.issuer,
    clientId: input.clientId,
    redirectUri: pending.redirectUri,
    code,
    verifier: pending.verifier,
    nonce: pending.nonce,
    fetcher: input.fetcher,
  })
}

async function consumePendingAuthorization(
  cache: TokenCache,
  state: string,
): Promise<PendingAuthorization> {
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
    const value = await cache.getToken(key)
    if (!value) {
      throw new Error('[xid-kit/react-native] PKCE verifier missing from token cache.')
    }
    await cache.deleteToken(key)
    try {
      const record = JSON.parse(value) as Partial<PendingAuthorization>
      if (
        typeof record.verifier !== 'string' ||
        record.verifier.length === 0 ||
        typeof record.nonce !== 'string' ||
        record.nonce.length === 0 ||
        typeof record.redirectUri !== 'string' ||
        record.redirectUri.length === 0
      ) {
        throw new Error()
      }
      return {
        verifier: record.verifier,
        nonce: record.nonce,
        redirectUri: record.redirectUri,
      }
    } catch {
      throw new Error('[xid-kit/react-native] Pending authorization record is invalid.')
    }
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
    fetcher,
    restoreSession,
    commitAuthorizationSession,
  } = useXidRnContext()
  const [signInState, setSignInState] = useState<SignInState>({ status: 'idle' })

  const signIn = useCallback(
    async (options: SignInOptions = {}): Promise<void> => {
      setSignInState({ status: 'pending' })

      let pendingKey: string | null = null
      try {
        const redirectUri = options.redirectUri ?? defaultRedirectUri
        const scopes = options.scopes ?? defaultScopes
        if (!scopes.includes('openid')) {
          throw new Error('[xid-kit/react-native] OIDC sign-in requires the openid scope.')
        }
        if (scopes.includes('offline_access')) {
          throw new Error(
            '[xid-kit/react-native] offline_access requires DPoP sender binding, which this SDK does not implement.',
          )
        }

        const verifier = createPkceVerifier(64)
        const state = createRandomString(32)
        const nonce = createRandomString(43)
        const challenge = await createPkceChallenge(verifier)

        const authorizeUrl = new URL('/authorize', issuer)
        authorizeUrl.searchParams.set('client_id', clientId)
        authorizeUrl.searchParams.set('redirect_uri', redirectUri)
        authorizeUrl.searchParams.set('response_type', 'code')
        authorizeUrl.searchParams.set('scope', scopes.join(' '))
        authorizeUrl.searchParams.set('state', state)
        authorizeUrl.searchParams.set('nonce', nonce)
        authorizeUrl.searchParams.set('code_challenge', challenge)
        authorizeUrl.searchParams.set('code_challenge_method', 'S256')

        pendingKey = pendingAuthorizationKey(state)
        await tokenCache.saveToken(
          pendingKey,
          JSON.stringify({ verifier, nonce, redirectUri } satisfies PendingAuthorization),
        )

        const result = await browser.openAuthSession(authorizeUrl.toString(), redirectUri)

        if (result.type === 'cancel' || result.type === 'dismiss') {
          await tokenCache.deleteToken(pendingKey)
          setSignInState({ status: 'cancelled' })
          return
        }

        const tokens = await processCallback({
          url: result.url,
          tokenCache,
          issuer,
          clientId,
          fetcher,
        })
        await commitAuthorizationSession(tokens)
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
    [
      tokenCache,
      browser,
      issuer,
      clientId,
      defaultRedirectUri,
      defaultScopes,
      fetcher,
      restoreSession,
      commitAuthorizationSession,
    ],
  )

  const handleRedirect = useCallback(
    async (url: string): Promise<void> => {
      try {
        const tokens = await processCallback({
          url,
          tokenCache,
          issuer,
          clientId,
          fetcher,
        })
        await commitAuthorizationSession(tokens)
        await restoreSession()
        setSignInState({ status: 'complete' })
      } catch (err) {
        setSignInState({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    },
    [tokenCache, issuer, clientId, fetcher, commitAuthorizationSession, restoreSession],
  )

  return { signInState, signIn, handleRedirect }
}
