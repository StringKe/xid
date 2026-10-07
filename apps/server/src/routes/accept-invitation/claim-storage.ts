// 邀请邮件认领的会话存储:claim token 与 recovery key 只放 sessionStorage,存储不可用时退回组件内存。

import { sha256Hex } from '@xid-kit/crypto'

export type ClaimRecovery = {
  identifier: string
  recoveryKey: string
}

const CLAIM_STORAGE_PREFIX = 'xid.invitation-claim'
const CURRENT_CLAIM_IDENTIFIER_KEY = `${CLAIM_STORAGE_PREFIX}.current`

function claimTokenStorageKey(identifier: string): string {
  return `${CLAIM_STORAGE_PREFIX}.${identifier}.token`
}

function recoveryStorageKey(identifier: string): string {
  return `${CLAIM_STORAGE_PREFIX}.${identifier}.recovery`
}

function getSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

export function readStoredClaimToken(): string | null {
  const storage = getSessionStorage()
  if (!storage) return null
  try {
    const identifier = storage.getItem(CURRENT_CLAIM_IDENTIFIER_KEY)
    if (!identifier || !/^[0-9a-f]{64}$/.test(identifier)) return null
    return storage.getItem(claimTokenStorageKey(identifier))
  } catch {
    return null
  }
}

export async function rememberClaimToken(token: string): Promise<string> {
  const identifier = await sha256Hex(token)
  const storage = getSessionStorage()
  if (!storage) return identifier
  try {
    storage.setItem(claimTokenStorageKey(identifier), token)
    storage.setItem(CURRENT_CLAIM_IDENTIFIER_KEY, identifier)
  } catch {
    // 存储不可用时 claim 仍可从组件内存使用。
  }
  return identifier
}

function randomRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}

export async function getOrCreateRecovery(
  token: string,
  current: ClaimRecovery | null,
): Promise<ClaimRecovery> {
  const identifier = await sha256Hex(token)
  if (current?.identifier === identifier) return current

  const storage = getSessionStorage()
  if (storage) {
    try {
      const stored = storage.getItem(recoveryStorageKey(identifier))
      if (stored && stored.length >= 32 && stored.length <= 256) {
        return { identifier, recoveryKey: stored }
      }
    } catch {
      // 内存 recovery key 仍保证本页实例内重试幂等。
    }
  }

  const recovery = { identifier, recoveryKey: randomRecoveryKey() }
  if (storage) {
    try {
      storage.setItem(recoveryStorageKey(identifier), recovery.recoveryKey)
    } catch {
      // 关页前内存 recovery key 足够。
    }
  }
  return recovery
}

export function clearClaimStorage(identifier: string): void {
  const storage = getSessionStorage()
  if (!storage) return
  try {
    storage.removeItem(claimTokenStorageKey(identifier))
    storage.removeItem(recoveryStorageKey(identifier))
    if (storage.getItem(CURRENT_CLAIM_IDENTIFIER_KEY) === identifier) {
      storage.removeItem(CURRENT_CLAIM_IDENTIFIER_KEY)
    }
  } catch {
    // 成功响应已消费一次性 server proof。
  }
}

export function clearCurrentClaimStorage(): void {
  const storage = getSessionStorage()
  if (!storage) return
  try {
    const identifier = storage.getItem(CURRENT_CLAIM_IDENTIFIER_KEY)
    if (identifier && /^[0-9a-f]{64}$/.test(identifier)) {
      clearClaimStorage(identifier)
      return
    }
    storage.removeItem(CURRENT_CLAIM_IDENTIFIER_KEY)
  } catch {
    // 清理 session storage 失败时原始邀请仍可用。
  }
}

export function claimTokenFromFragment(): string | null {
  const hash = globalThis.location.hash
  if (!hash.startsWith('#')) return null
  const token = new URLSearchParams(hash.slice(1)).get('claim_token')?.trim()
  return token || null
}

export function scrubFragment(): void {
  globalThis.history.replaceState(
    globalThis.history.state,
    '',
    `${globalThis.location.pathname}${globalThis.location.search}`,
  )
}
