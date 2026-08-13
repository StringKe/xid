import { useCallback, useLayoutEffect, useState } from 'react'

type OneTimeLinkToken = {
  token: string | null
  ready: boolean
  clearToken: () => void
}

function sessionStorageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function fragmentToken(parameter: string): string | null {
  const hash = globalThis.location.hash
  if (!hash.startsWith('#')) return null
  return new URLSearchParams(hash.slice(1)).get(parameter)?.trim() || null
}

function storedToken(storageKey: string): string | null {
  try {
    return sessionStorageOrNull()?.getItem(storageKey)?.trim() || null
  } catch {
    return null
  }
}

function rememberToken(storageKey: string, token: string): void {
  try {
    sessionStorageOrNull()?.setItem(storageKey, token)
  } catch {
    // 组件内存仍保留本页确认所需的 credential。
  }
}

function scrubCredentialUrl(fragmentParameter: string, legacyQueryToken: string | null): void {
  const url = new URL(globalThis.location.href)
  let changed = false
  if (new URLSearchParams(url.hash.slice(1)).has(fragmentParameter)) {
    url.hash = ''
    changed = true
  }
  if (legacyQueryToken !== null && url.searchParams.has('token')) {
    url.searchParams.delete('token')
    changed = true
  }
  if (!changed) return
  globalThis.history.replaceState(
    globalThis.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  )
}

// Action-link credential 只从 fragment/旧 query 捕获到组件状态与 sessionStorage,随后立即清理 URL。
export function useOneTimeLinkToken(input: {
  storageKey: string
  fragmentParameter?: string
  legacyQueryToken?: string | null
}): OneTimeLinkToken {
  const fragmentParameter = input.fragmentParameter ?? 'token'
  const legacyQueryToken = input.legacyQueryToken?.trim() || null
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState<string | null>(
    () => fragmentToken(fragmentParameter) ?? legacyQueryToken ?? storedToken(input.storageKey),
  )

  useLayoutEffect(() => {
    const captured = fragmentToken(fragmentParameter) ?? legacyQueryToken
    if (captured) {
      rememberToken(input.storageKey, captured)
      setToken(captured)
    }
    scrubCredentialUrl(fragmentParameter, legacyQueryToken)
    setReady(true)
  }, [fragmentParameter, input.storageKey, legacyQueryToken])

  const clearToken = useCallback(() => {
    try {
      sessionStorageOrNull()?.removeItem(input.storageKey)
    } catch {
      // Server 已消费 credential;storage 清理失败不会改变安全状态。
    }
    setToken(null)
  }, [input.storageKey])

  return { token, ready, clearToken }
}
