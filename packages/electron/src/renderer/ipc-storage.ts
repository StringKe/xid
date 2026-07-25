// Renderer process: IPC-backed SecureStorageAdapter.
// Calls into the contextBridge-exposed xidBridge.storage which the preload
// script wires to ipcRenderer.invoke calls on the main process.

import type { SecureStorageAdapter, XidBridge } from '../types'
import { XID_BRIDGE_KEY } from '../types'

// Typed window augmentation so TypeScript knows about window.xidBridge.
// The actual binding is created by the preload script at runtime.
type BridgedWindow = typeof globalThis & {
  readonly [XID_BRIDGE_KEY]?: XidBridge
}

/**
 * Returns the SecureStorageAdapter from the contextBridge.
 * Throws if the preload script has not set up the bridge (i.e. the renderer
 * was loaded without the correct preload).
 */
export function getIpcStorageAdapter(): SecureStorageAdapter {
  const bridge = (globalThis as BridgedWindow)[XID_BRIDGE_KEY]
  if (!bridge) {
    throw new Error(
      '[xid-electron] window.xidBridge is not defined. ' +
        'Ensure your BrowserWindow uses the xid preload script.',
    )
  }
  return bridge.storage
}

/**
 * Returns the full XidBridge. Useful when the renderer needs signIn/signOut
 * without going through XidClient.
 */
export function getXidBridge(): XidBridge {
  const bridge = (globalThis as BridgedWindow)[XID_BRIDGE_KEY]
  if (!bridge) {
    throw new Error(
      '[xid-electron] window.xidBridge is not defined. ' +
        'Ensure your BrowserWindow uses the xid preload script.',
    )
  }
  return bridge
}
