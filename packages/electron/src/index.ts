// 兼容入口：优先用 main / renderer / preload 子路径；根导出供测试与旧解析。

export * from './renderer/index'

export type {
  XidElectronMainOptions,
  LoopbackCallbackServer,
  StartLoopbackServer,
  PkceChallenge,
} from './types'

export { IPC_CHANNELS, XID_BRIDGE_KEY } from './types'

export { buildAuthorizeUrl, parseCallbackUrl, generateState } from './pkce'
