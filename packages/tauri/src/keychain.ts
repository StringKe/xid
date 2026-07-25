// Keychain adapter contract and implementations.
// XidKeychainAdapter is the interface the rest of the package uses for token storage.
// Two implementations:
//   - MemoryKeychainAdapter: for dev and unit tests (no Tauri runtime required)
//   - TauriKeychainAdapter: delegates to a Rust plugin via Tauri invoke

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export type XidKeychainAdapter = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Memory adapter (dev / test)
// ---------------------------------------------------------------------------

export function createMemoryKeychainAdapter(): XidKeychainAdapter {
  const store = new Map<string, string>()
  return {
    async getItem(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async setItem(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async removeItem(key: string): Promise<void> {
      store.delete(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Tauri keychain adapter
// Calls the `plugin:xid-keychain` Rust plugin commands via Tauri invoke.
// See templates/xid-keychain-plugin.rs for the Rust side reference.
// ---------------------------------------------------------------------------

// Pass window.__TAURI__.core.invoke or the named import from @tauri-apps/api/core.
// Typed as a narrow function signature to avoid importing @tauri-apps/api at runtime.
export type TauriInvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

export type TauriKeychainAdapterOptions = {
  invoke: TauriInvokeFn
  // Tauri plugin command prefix. Default: "plugin:xid-keychain"
  pluginPrefix?: string
}

export function createTauriKeychainAdapter(
  options: TauriKeychainAdapterOptions,
): XidKeychainAdapter {
  const prefix = options.pluginPrefix ?? 'plugin:xid-keychain'
  const { invoke } = options

  return {
    async getItem(key: string): Promise<string | null> {
      const result = await invoke(`${prefix}|get`, { key })
      if (result === null || result === undefined) return null
      if (typeof result === 'string') return result
      return null
    },
    async setItem(key: string, value: string): Promise<void> {
      await invoke(`${prefix}|set`, { key, value })
    },
    async removeItem(key: string): Promise<void> {
      await invoke(`${prefix}|delete`, { key })
    },
  }
}
