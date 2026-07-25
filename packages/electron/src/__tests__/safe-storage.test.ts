// ElectronSafeStorage unit tests -- mocks Electron and node:fs/node:crypto
// so the tests run without an actual Electron environment.

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks -- must be hoisted before any imports that use them.
// ---------------------------------------------------------------------------

const fakeFs: Record<string, Buffer | string> = {}

vi.mock('node:crypto', () => ({
  createHash: (_alg: string) => {
    let input = ''
    return {
      update: (data: string) => {
        input += data
        return {
          digest: (enc: string) => Buffer.from(input).toString(enc === 'hex' ? 'hex' : 'utf8'),
        }
      },
    }
  },
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockImplementation((path: string, data: Buffer | string) => {
    fakeFs[path] = data
    return Promise.resolve()
  }),
  readFile: vi.fn().mockImplementation((path: string) => {
    const data = fakeFs[path]
    if (data === undefined) return Promise.reject(new Error('ENOENT'))
    return Promise.resolve(typeof data === 'string' ? Buffer.from(data) : data)
  }),
  rm: vi.fn().mockImplementation((path: string) => {
    delete fakeFs[path]
    return Promise.resolve()
  }),
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}))

// Default mock: encryption IS available.
const mockSafeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((text: string) => Buffer.from(`enc:${text}`)),
  decryptString: vi.fn((buf: Buffer) => {
    const raw = buf.toString()
    // Only strip the enc: prefix that this mock's encryptString writes.
    // This makes plaintext writes distinguishable from encrypted writes at
    // the mock level: encrypted data always has the prefix; plaintext never does.
    if (!raw.startsWith('enc:')) throw new Error('decryptString: not an encrypted blob')
    return raw.slice(4)
  }),
}

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
}))

// ---------------------------------------------------------------------------
// Actual imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { ElectronSafeStorage, ElectronStorageError } from '../main/safe-storage'
import * as fsPromises from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ElectronSafeStorage', () => {
  beforeEach(() => {
    Object.keys(fakeFs).forEach((k) => delete fakeFs[k])
    vi.clearAllMocks()
    // Reset encryption to available by default.
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
    mockSafeStorage.encryptString.mockImplementation((text: string) => Buffer.from(`enc:${text}`))
    mockSafeStorage.decryptString.mockImplementation((buf: Buffer) => {
      const raw = buf.toString()
      if (!raw.startsWith('enc:')) throw new Error('decryptString: not an encrypted blob')
      return raw.slice(4)
    })
  })

  it('init() creates the storage directory', async () => {
    const storage = new ElectronSafeStorage('/tmp/test')

    await storage.init()

    expect(fsPromises.mkdir).toHaveBeenCalledWith('/tmp/test', { recursive: true })
  })

  it('setItem() + getItem() round-trips a value using encryption', async () => {
    const storage = new ElectronSafeStorage('/tmp/test')

    await storage.setItem('my-key', 'secret-value')
    const result = await storage.getItem('my-key')

    // The mock encryptString writes enc: prefix; decryptString strips it.
    // Round-trip must recover the original plaintext.
    expect(result).toBe('secret-value')
    // encryptString must have been called (not a plaintext bypass).
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('secret-value')
    // decryptString must have been called on read.
    expect(mockSafeStorage.decryptString).toHaveBeenCalled()
  })

  it('getItem() returns null for a missing key', async () => {
    const storage = new ElectronSafeStorage('/tmp/test')

    const result = await storage.getItem('nonexistent')

    expect(result).toBeNull()
  })

  it('removeItem() deletes the stored value', async () => {
    const storage = new ElectronSafeStorage('/tmp/test')
    await storage.setItem('del-key', 'to-be-deleted')

    await storage.removeItem('del-key')

    expect(await storage.getItem('del-key')).toBeNull()
  })

  it('removeItem() on missing key does not throw', async () => {
    const storage = new ElectronSafeStorage('/tmp/test')

    await expect(storage.removeItem('does-not-exist')).resolves.toBeUndefined()
  })

  it('different keys are stored in separate files', async () => {
    const storage = new ElectronSafeStorage('/tmp/test')

    await storage.setItem('key-a', 'value-a')
    await storage.setItem('key-b', 'value-b')

    expect(await storage.getItem('key-a')).toBe('value-a')
    expect(await storage.getItem('key-b')).toBe('value-b')
  })

  // ---------------------------------------------------------------------------
  // Encryption-unavailable branches
  // ---------------------------------------------------------------------------

  it('setItem() throws ElectronStorageError when encryption is unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    const storage = new ElectronSafeStorage('/tmp/test')

    await expect(storage.setItem('key', 'value')).rejects.toBeInstanceOf(ElectronStorageError)
  })

  it('ElectronStorageError.code is encryption_unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    const storage = new ElectronSafeStorage('/tmp/test')

    try {
      await storage.setItem('key', 'value')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ElectronStorageError)
      expect((err as ElectronStorageError).code).toBe('encryption_unavailable')
    }
  })

  it('setItem() does NOT write plaintext to disk when encryption is unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    const storage = new ElectronSafeStorage('/tmp/test')

    try {
      await storage.setItem('key', 'my-secret')
    } catch {
      // Expected throw -- ignore.
    }

    // writeFile must NOT have been called with the plaintext value.
    expect(fsPromises.writeFile).not.toHaveBeenCalled()
  })

  it('getItem() returns null when encryption is unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    const storage = new ElectronSafeStorage('/tmp/test')

    const result = await storage.getItem('any-key')

    expect(result).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // IPC handler registration
  // ---------------------------------------------------------------------------

  it('registerIpcHandlers registers the 3 storage IPC channels', () => {
    const storage = new ElectronSafeStorage('/tmp/test')
    const handles: string[] = []
    const mockIpcMain = {
      handle: (channel: string) => {
        handles.push(channel)
      },
      removeHandler: vi.fn(),
    } as unknown as import('electron').IpcMain

    storage.registerIpcHandlers(mockIpcMain)

    expect(handles).toContain('xid:storage:set')
    expect(handles).toContain('xid:storage:get')
    expect(handles).toContain('xid:storage:remove')
  })

  it('removeIpcHandlers removes the 3 storage IPC channels', () => {
    const storage = new ElectronSafeStorage('/tmp/test')
    const removed: string[] = []
    const mockIpcMain = {
      handle: vi.fn(),
      removeHandler: (channel: string) => {
        removed.push(channel)
      },
    } as unknown as import('electron').IpcMain

    storage.removeIpcHandlers(mockIpcMain)

    expect(removed).toContain('xid:storage:set')
    expect(removed).toContain('xid:storage:get')
    expect(removed).toContain('xid:storage:remove')
  })
})
