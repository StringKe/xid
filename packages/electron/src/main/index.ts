// main 进程入口：勿在 renderer / preload 中 import。

export { XidElectronApp } from './xid-app'
export { ElectronSafeStorage, ElectronStorageError } from './safe-storage'
export { startLoopbackServer } from './loopback-server'
export { XidCustomSchemeHandler } from './custom-scheme'

export type {
  XidElectronMainOptions,
  LoopbackCallbackServer,
  StartLoopbackServer,
  PkceChallenge,
  SignInOptions,
  IpcChannels,
} from '../types'

export { IPC_CHANNELS } from '../types'
