// @xid-kit/electron — ./preload entry point.
// This file runs in the preload context: it has access to both Node.js/Electron
// APIs AND the DOM, but contextIsolation means it cannot access renderer globals
// directly. contextBridge.exposeInMainWorld() is the ONLY safe way to send
// functions to the renderer.
//
// This module MUST be bundled separately (preload: true in the Electron build)
// and loaded via webPreferences.preload in BrowserWindow constructor.

import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, XID_BRIDGE_KEY } from '../types'
import type { SecureStorageAdapter, XidBridge, SignInOptions } from '../types'

// ---------------------------------------------------------------------------
// Storage adapter: proxies IPC calls to main process safeStorage handlers.
// ---------------------------------------------------------------------------

const storage: SecureStorageAdapter = {
  setItem: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET, key, value),
  getItem: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET, key),
  removeItem: (key: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_REMOVE, key),
}

// ---------------------------------------------------------------------------
// OAuth bridge: delegates sign-in/sign-out to main process (has shell access).
// ---------------------------------------------------------------------------

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

// Expose to the renderer world as window.xidBridge.
contextBridge.exposeInMainWorld(XID_BRIDGE_KEY, bridge)
