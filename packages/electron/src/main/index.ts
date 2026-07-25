// @xid-kit/electron -- ./main entry point.
// All exports here run in the Electron main process only.
// Do NOT import in renderer or preload code.

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
