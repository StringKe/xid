// Main process: safeStorage-backed token persistence.
// Uses Electron safeStorage (OS keychain encryption) + node:fs for blob storage.
// This module runs ONLY in the main process (has access to Electron + Node).
//
// Architecture:
//   Encrypted blob = safeStorage.encryptString(plaintext) -> Buffer
//   Persisted as raw binary files in storageDir.
//   File name = sha256-like sanitized key to avoid path traversal.
//
// IPC: ipcMain.handle() registers handlers so the renderer (via contextBridge)
// can call storage ops over IPC without touching main-process Node APIs directly.

import type { IpcMain } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { IPC_CHANNELS } from '../types'

// Typed error for storage operations — allows callers to catch and handle specifically.
export class ElectronStorageError extends Error {
  override readonly name = 'ElectronStorageError'
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

// Main process safe-storage manager.
export class ElectronSafeStorage {
  readonly #storageDir: string

  constructor(storageDir: string) {
    this.#storageDir = storageDir
  }

  /**
   * Ensure storage directory exists. Call once during app ready before
   * registering IPC handlers.
   */
  async init(): Promise<void> {
    await mkdir(this.#storageDir, { recursive: true })
  }

  async setItem(key: string, value: string): Promise<void> {
    const { safeStorage } = await importElectron()
    if (!safeStorage.isEncryptionAvailable()) {
      // Encryption unavailable (headless Linux without a keyring daemon).
      // Writing tokens in plaintext silently violates the platform-matrix safeStorage
      // security contract and the error-handling rule (not吞错). Throw so the
      // caller can decide to opt-in explicitly or deny the operation.
      throw new ElectronStorageError(
        '[xid-electron] safeStorage encryption is not available on this system. ' +
          'Ensure a keyring / secret service is running, or provide an explicit storageDir ' +
          'with an external encrypted storage solution.',
        'encryption_unavailable',
      )
    }
    const encrypted = safeStorage.encryptString(value)
    await writeFile(this.#filePath(key), encrypted)
  }

  async getItem(key: string): Promise<string | null> {
    const { safeStorage } = await importElectron()
    if (!safeStorage.isEncryptionAvailable()) {
      // Symmetric with setItem: if encryption is unavailable we refuse to read
      // (there should be no blob on disk written by this class anyway).
      return null
    }
    try {
      const raw = await readFile(this.#filePath(key))
      return safeStorage.decryptString(raw)
    } catch {
      // File missing (item not set) or decrypt failed (corrupted blob): treat as absent.
      return null
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await rm(this.#filePath(key))
    } catch {
      // File may not exist — treat as a no-op.
    }
  }

  /**
   * Register IPC handlers so the preload contextBridge can proxy storage ops
   * from the renderer. Call during app ready after calling init().
   */
  registerIpcHandlers(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.STORAGE_SET, (_event, key: string, value: string) =>
      this.setItem(key, value),
    )

    ipcMain.handle(IPC_CHANNELS.STORAGE_GET, (_event, key: string) => this.getItem(key))

    ipcMain.handle(IPC_CHANNELS.STORAGE_REMOVE, (_event, key: string) => this.removeItem(key))
  }

  /**
   * Remove all IPC handlers registered by this instance.
   * Call when the BrowserWindow is closed to avoid handler leaks.
   */
  removeIpcHandlers(ipcMain: IpcMain): void {
    ipcMain.removeHandler(IPC_CHANNELS.STORAGE_SET)
    ipcMain.removeHandler(IPC_CHANNELS.STORAGE_GET)
    ipcMain.removeHandler(IPC_CHANNELS.STORAGE_REMOVE)
  }

  #filePath(key: string): string {
    // Sanitize key to a hex digest to prevent path traversal.
    const safe = createHash('sha256').update(key).digest('hex')
    return join(this.#storageDir, safe)
  }
}

// Lazy import of electron to keep the module loadable in test environments.
// Memoize the import promise: concurrent setItem calls (Promise.all) would otherwise
// fire parallel dynamic imports of the same module.
let electronModule: Promise<typeof import('electron')> | null = null

function importElectron(): Promise<typeof import('electron')> {
  electronModule ??= import('electron') as unknown as Promise<typeof import('electron')>
  return electronModule
}
