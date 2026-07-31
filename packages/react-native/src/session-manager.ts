import type { TokenCache } from './token-cache'
import { clearTokenSet, isSessionPending, readTokenSet, saveTokenSet } from './token-exchange'
import type { StoredTokenSet, TokenSet } from './token-exchange'

const sessionMutationTails = new Map<TokenCache | string, Promise<void>>()

type SessionManagerOptions = {
  tokenCache: TokenCache
}

export class XidSessionManager {
  readonly #tokenCache: TokenCache

  constructor(options: SessionManagerOptions) {
    this.#tokenCache = options.tokenCache
  }

  async restore(): Promise<StoredTokenSet | null> {
    return this.#withExclusiveMutation(async () => {
      const stored = await readTokenSet(this.#tokenCache)
      if (stored && stored.expiresAt > Date.now()) return stored
      if (stored || (await isSessionPending(this.#tokenCache))) {
        await this.#clearUnsafe()
      }
      return null
    })
  }

  async getAccessToken(): Promise<string | null> {
    return (await this.restore())?.accessToken ?? null
  }

  async commitAuthorizationSession(tokens: TokenSet): Promise<StoredTokenSet> {
    return this.#withExclusiveMutation(async () => {
      await saveTokenSet(this.#tokenCache, tokens)
      const stored = await readTokenSet(this.#tokenCache)
      if (!stored) {
        throw new Error('[xid-kit/react-native] Unable to commit the authorization session.')
      }
      return stored
    })
  }

  async clear(): Promise<void> {
    await this.#withExclusiveMutation(() => this.#clearUnsafe())
  }

  async signOut(): Promise<void> {
    await this.#withExclusiveMutation(() => this.#clearUnsafe())
  }

  #coordinationKey(): TokenCache | string {
    return this.#tokenCache.coordinationNamespace ?? this.#tokenCache
  }

  async #clearUnsafe(): Promise<void> {
    const cleared = await clearTokenSet(this.#tokenCache)
    if (!cleared) {
      throw new Error('[xid-kit/react-native] Unable to clear the local session.')
    }
  }

  async #withExclusiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    const coordinationKey = this.#coordinationKey()
    const previous = sessionMutationTails.get(coordinationKey) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => gate,
      () => gate,
    )
    sessionMutationTails.set(coordinationKey, tail)

    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (sessionMutationTails.get(coordinationKey) === tail) {
        sessionMutationTails.delete(coordinationKey)
      }
    }
  }
}
