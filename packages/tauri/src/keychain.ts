// 内存适配器供 dev/test；Tauri 适配器经 invoke 调 plugin:xid-keychain（见 templates/xid-keychain-plugin.rs）。

export type XidKeychainAdapter = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

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

// 注入 window.__TAURI__.core.invoke 或 @tauri-apps/api/core 的 invoke；窄类型避免运行时依赖该包。
export type TauriInvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

export type TauriKeychainAdapterOptions = {
  invoke: TauriInvokeFn
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
