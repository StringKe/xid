// Expo 适配器与 Router 守卫；工厂函数由调用方注入模块实例以保持 CI typecheck 干净。

export { createSecureStoreAdapter } from './secure-store-adapter'
export type { SecureStoreAdapterOptions } from './secure-store-adapter'

export { createExpoWebBrowserAdapter } from './web-browser-adapter'
export type { ExpoWebBrowserAdapterOptions } from './web-browser-adapter'

export { useProtectedRoute } from './use-protected-route'
export type { ProtectedRouteOptions } from './use-protected-route'

export * from '@xid-kit/react-native'
