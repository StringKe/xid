// createSecureStoreAdapter:expo-secure-store -> @xid-kit/react-native TokenCache 适配器。
// 此文件在运行时动态 import expo-secure-store;类型仅用于类型擦除 -- 不在模块顶层 import,
// 避免非 Expo 环境(CI typecheck)报"找不到模块"。
// 调用方在 Expo app 中创建适配器并传入 XidProvider tokenCache prop。

import type { TokenCache } from '@xid-kit/react-native'

// SecureStore API subset 类型(避免顶层 import expo-secure-store 影响 CI typecheck)。
type SecureStoreModule = {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string, options?: object): Promise<void>
  deleteItemAsync(key: string, options?: object): Promise<void>
}

export type SecureStoreAdapterOptions = {
  // 注入 SecureStore 模块实例(调用方 import * as SecureStore from 'expo-secure-store' 后传入)。
  // 不在本模块顶层 import,以保持非 Expo 环境 typecheck 干净。
  secureStore: SecureStoreModule
  // 可选:key 前缀,用于命名空间隔离(默认无前缀)。
  keyPrefix?: string
}

export function createSecureStoreAdapter(options: SecureStoreAdapterOptions): TokenCache {
  const { secureStore, keyPrefix = '' } = options

  function prefixKey(key: string): string {
    // expo-secure-store keys must match [A-Za-z0-9._-]; colon is not allowed.
    // Use '.' as namespace separator to stay within the allowed character set.
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
