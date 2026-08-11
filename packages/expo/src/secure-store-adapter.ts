// expo-secure-store -> TokenCache 适配器；不在顶层 import 模块，由调用方注入以保持 CI typecheck 干净。

import type { TokenCache } from '@xid-kit/react-native'

type SecureStoreModule = {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string, options?: object): Promise<void>
  deleteItemAsync(key: string, options?: object): Promise<void>
}

export type SecureStoreAdapterOptions = {
  secureStore: SecureStoreModule
  keyPrefix?: string
}

export function createSecureStoreAdapter(options: SecureStoreAdapterOptions): TokenCache {
  const { secureStore, keyPrefix = '' } = options

  function prefixKey(key: string): string {
    // expo-secure-store key 仅允许 [A-Za-z0-9._-]，命名空间用 '.' 分隔，禁用冒号。
    return keyPrefix ? `${keyPrefix}.${key}` : key
  }

  return {
    coordinationNamespace: `expo-secure-store:${keyPrefix || 'default'}`,
    async getToken(key) {
      return secureStore.getItemAsync(prefixKey(key))
    },
    async saveToken(key, value) {
      await secureStore.setItemAsync(prefixKey(key), value)
    },
    async deleteToken(key) {
      await secureStore.deleteItemAsync(prefixKey(key))
    },
  }
}
