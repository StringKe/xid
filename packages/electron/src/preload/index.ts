// preload 入口：须独立打包并由 webPreferences.preload 加载；
// contextIsolation 下只能用 contextBridge.exposeInMainWorld 暴露给 renderer。

import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, XID_BRIDGE_KEY } from '../types'
import type { SecureStorageAdapter, XidBridge, SignInOptions } from '../types'

const storage: SecureStorageAdapter = {
  setItem: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET, key, value),
  getItem: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET, key),
  removeItem: (key: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_REMOVE, key),
}

const bridge: XidBridge = {
  storage,
  signIn: (options?: SignInOptions): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.SIGN_IN, options),
  signOut: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SIGN_OUT),
  getAccessToken: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.GET_ACCESS_TOKEN),
  getSession: (): Promise<{ accessToken: string; expiresAt: number } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION),
  setTokenStorage: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SET_TOKEN_STORAGE),
}

contextBridge.exposeInMainWorld(XID_BRIDGE_KEY, bridge)
