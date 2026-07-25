import type { TokenCache } from './token-cache'
import {
  clearTokenSet,
  isSessionPending,
  markSessionPending,
  readTokenSet,
  saveTokenSet,
} from './token-exchange'
import type { StoredTokenSet, TokenSet } from './token-exchange'

const REFRESH_LEEWAY_MILLISECONDS = 30_000
const refreshFlights = new Map<TokenCache | string, Promise<StoredTokenSet | null>>()

type SessionManagerOptions = {
  tokenCache: TokenCache
  issuer: string
  clientId: string
}

type RefreshResponse = {
  access_token?: unknown
  refresh_token?: unknown
  id_token?: unknown
  expires_in?: unknown
}

export class XidSessionManager {
  readonly #tokenCache: TokenCache
  readonly #issuer: string
  readonly #clientId: string

  constructor(options: SessionManagerOptions) {
    this.#tokenCache = options.tokenCache
    this.#issuer = options.issuer
    this.#clientId = options.clientId
  }

  async restore(): Promise<StoredTokenSet | null> {
    const stored = await readTokenSet(this.#tokenCache)
    if (!stored) return this.#restorePendingSession()
    if (stored.expiresAt > Date.now() + REFRESH_LEEWAY_MILLISECONDS) return stored
    if (!stored.refreshToken) {
      await clearTokenSet(this.#tokenCache)
      return null
    }
    return this.#refresh(stored.refreshToken)
  }

  async getAccessToken(): Promise<string | null> {
    return (await this.restore())?.accessToken ?? null
  }

  async clear(): Promise<void> {
    await clearTokenSet(this.#tokenCache)
  }

  async #refresh(refreshToken: string): Promise<StoredTokenSet | null> {
    const coordinationKey = this.#coordinationKey()
    const existingRefresh = refreshFlights.get(coordinationKey)
    if (existingRefresh) return existingRefresh

    const refreshInFlight = this.#refreshToken(refreshToken)
    refreshFlights.set(coordinationKey, refreshInFlight)
    try {
      return await refreshInFlight
    } finally {
      if (refreshFlights.get(coordinationKey) === refreshInFlight) {
        refreshFlights.delete(coordinationKey)
      }
    }
  }

  async #restorePendingSession(): Promise<StoredTokenSet | null> {
    if (!(await isSessionPending(this.#tokenCache))) return null

    const refreshInFlight = refreshFlights.get(this.#coordinationKey())
    if (!refreshInFlight) return null

    await refreshInFlight
    return readTokenSet(this.#tokenCache)
  }

  #coordinationKey(): TokenCache | string {
    return this.#tokenCache.coordinationNamespace ?? this.#tokenCache
  }

  async #refreshToken(refreshToken: string): Promise<StoredTokenSet | null> {
    try {
      await markSessionPending(this.#tokenCache)
      const response = await fetch(new URL('/token', this.#issuer).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.#clientId,
          refresh_token: refreshToken,
        }).toString(),
      })
      if (!response.ok) {
        await clearTokenSet(this.#tokenCache)
        return null
      }

      const data = (await response.json()) as RefreshResponse
      if (typeof data.access_token !== 'string') {
        await clearTokenSet(this.#tokenCache)
        return null
      }

      const tokens: TokenSet = {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken,
        idToken: typeof data.id_token === 'string' ? data.id_token : null,
        expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
      }
      await saveTokenSet(this.#tokenCache, tokens)
      return readTokenSet(this.#tokenCache)
    } catch {
      await clearTokenSet(this.#tokenCache)
      return null
    }
  }
}
