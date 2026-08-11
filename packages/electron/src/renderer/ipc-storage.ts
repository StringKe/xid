// 经 contextBridge 的 SecureStorageAdapter；绑定由 preload 在运行时写入。

import type { SecureStorageAdapter, XidBridge } from '../types'
import { XID_BRIDGE_KEY } from '../types'

type BridgedWindow = typeof globalThis & {
  readonly [XID_BRIDGE_KEY]?: XidBridge
}

/** 未挂载 preload 时抛错，避免静默落到未加密存储。 */
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
