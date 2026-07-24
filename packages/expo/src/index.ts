// @xid-kit/expo:Expo SDK — expo-secure-store + expo-web-browser 的具体适配器 +
// Expo Router useProtectedRoute hook。
// 基于 @xid-kit/react-native(依赖注入层),接入 Expo 生态具体实现。
// 见 docs/sdks/platform-matrix.md 移动端行(expo 行)。

// --- Expo 具体适配器(工厂函数,调用方注入模块实例以保持 CI typecheck 干净)---
export { createSecureStoreAdapter } from './secure-store-adapter'
export type { SecureStoreAdapterOptions } from './secure-store-adapter'

export { createExpoWebBrowserAdapter } from './web-browser-adapter'
export type { ExpoWebBrowserAdapterOptions } from './web-browser-adapter'

// --- Expo Router guard hook ---
export { useProtectedRoute } from './use-protected-route'
export type { ProtectedRouteOptions } from './use-protected-route'

// --- re-export 全部 @xid-kit/react-native 公共 API(一站式使用)---
export * from '@xid-kit/react-native'
