// safeStorage + 本地文件落盘 token；仅 main 进程。
// 密钥经 OS keychain 加密；文件名对 key 做 hash，防 path traversal；经 IPC 供 preload 代理。

import type { IpcMain } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { IPC_CHANNELS } from '../types'

export class ElectronStorageError extends Error {
  override readonly name = 'ElectronStorageError'
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export class ElectronSafeStorage {
  readonly #storageDir: string

  constructor(storageDir: string) {
    this.#storageDir = storageDir
  }

  async init(): Promise<void> {
    await mkdir(this.#storageDir, { recursive: true })
  }

  async setItem(key: string, value: string): Promise<void> {
    const { safeStorage } = await importElectron()
    if (!safeStorage.isEncryptionAvailable()) {
      // 无 keyring 时静默明文写会破坏安全契约，fail-closed。
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
      // 与 setItem 对称：不可加密则不读（本类本就不写明文 blob）。
      return null
    }
    try {
      const raw = await readFile(this.#filePath(key))
      return safeStorage.decryptString(raw)
    } catch {
      // 缺失或损坏均视为不存在，避免向调用方泄露细节。
      return null
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await rm(this.#filePath(key))
    } catch {
      // 文件不存在时 no-op。
    }
  }

  registerIpcHandlers(ipcMain: IpcMain): void {
    ipcMain.handle(IPC_CHANNELS.STORAGE_SET, (_event, key: string, value: string) =>
      this.setItem(key, value),
    )

    ipcMain.handle(IPC_CHANNELS.STORAGE_GET, (_event, key: string) => this.getItem(key))

    ipcMain.handle(IPC_CHANNELS.STORAGE_REMOVE, (_event, key: string) => this.removeItem(key))
  }

  removeIpcHandlers(ipcMain: IpcMain): void {
    ipcMain.removeHandler(IPC_CHANNELS.STORAGE_SET)
    ipcMain.removeHandler(IPC_CHANNELS.STORAGE_GET)
    ipcMain.removeHandler(IPC_CHANNELS.STORAGE_REMOVE)
  }

  #filePath(key: string): string {
    // 将 key 映射为 hex digest，防止 path traversal。
    const safe = createHash('sha256').update(key).digest('hex')
    return join(this.#storageDir, safe)
  }
}

// 惰性 import electron 以便测试环境可加载本模块；
// 缓存 Promise，避免并发 setItem 触发多次并行 dynamic import。
let electronModule: Promise<typeof import('electron')> | null = null

function importElectron(): Promise<typeof import('electron')> {
  electronModule ??= import('electron') as unknown as Promise<typeof import('electron')>
  return electronModule
}
