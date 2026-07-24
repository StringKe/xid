// @xid-kit/electron — default/compat entry.
// For most usage, prefer the explicit sub-entries:
//   @xid-kit/electron/main     -> main process
//   @xid-kit/electron/renderer -> renderer process
//   @xid-kit/electron/preload  -> preload script
//
// This barrel re-exports the renderer surface + types for backwards compat
// and for environments that resolve the package root (e.g. unit tests).

export * from './renderer/index'

// Types shared across all three contexts.
export type {
  XidElectronMainOptions,
  LoopbackCallbackServer,
  StartLoopbackServer,
  PkceChallenge,
} from './types'

export { IPC_CHANNELS, XID_BRIDGE_KEY } from './types'

// PKCE helpers exposed for advanced usage / custom OAuth flows.
export { buildAuthorizeUrl, parseCallbackUrl, generateState } from './pkce'
