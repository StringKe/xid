// Typed session and token storage on top of XidKeychainAdapter.
// Keys are namespaced under "xid." to avoid collisions.
// Serialisation is kept in one place so all read/write paths stay consistent.

import type { XidKeychainAdapter } from './keychain'
import type { StoredSession } from './types'

export const KEYCHAIN_KEYS = {
  accessToken: 'xid.access_token',
  refreshToken: 'xid.refresh_token',
  session: 'xid.session',
  pkceVerifier: 'xid.pkce_verifier',
  oauthState: 'xid.oauth_state',
  authorizationCode: 'xid.authorization_code',
} as const

export type SessionStore = {
  getAccessToken(): Promise<string | null>
  setAccessToken(token: string): Promise<void>
  getRefreshToken(): Promise<string | null>
  setRefreshToken(token: string): Promise<void>
  getSession(): Promise<StoredSession | null>
  setSession(session: StoredSession): Promise<void>
  getPkceVerifier(): Promise<string | null>
  setPkceVerifier(verifier: string): Promise<void>
  getOauthState(): Promise<string | null>
  setOauthState(state: string): Promise<void>
  clearAll(): Promise<void>
}

export function createSessionStore(adapter: XidKeychainAdapter): SessionStore {
  return {
    getAccessToken: () => adapter.getItem(KEYCHAIN_KEYS.accessToken),
    setAccessToken: (token) => adapter.setItem(KEYCHAIN_KEYS.accessToken, token),

    getRefreshToken: () => adapter.getItem(KEYCHAIN_KEYS.refreshToken),
    setRefreshToken: (token) => adapter.setItem(KEYCHAIN_KEYS.refreshToken, token),

    async getSession(): Promise<StoredSession | null> {
      const raw = await adapter.getItem(KEYCHAIN_KEYS.session)
      if (!raw) return null
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!isStoredSession(parsed)) return null
        return parsed
      } catch {
        return null
      }
    },

    async setSession(session: StoredSession): Promise<void> {
      await adapter.setItem(KEYCHAIN_KEYS.session, JSON.stringify(session))
    },

    getPkceVerifier: () => adapter.getItem(KEYCHAIN_KEYS.pkceVerifier),
    setPkceVerifier: (v) => adapter.setItem(KEYCHAIN_KEYS.pkceVerifier, v),

    getOauthState: () => adapter.getItem(KEYCHAIN_KEYS.oauthState),
    setOauthState: (s) => adapter.setItem(KEYCHAIN_KEYS.oauthState, s),

    async clearAll(): Promise<void> {
      await Promise.all(Object.values(KEYCHAIN_KEYS).map((k) => adapter.removeItem(k)))
    },
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.userId === 'string' && typeof v.expiresAt === 'number'
}
