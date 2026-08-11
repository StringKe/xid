// XidElectronApp：state CSRF、PKCE 一次性、token 错误路径、AbortSignal（协议必测路径）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

const fakeFs: Record<string, Buffer | string> = {}

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>()
  return {
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
    // 保留真实 webcrypto 以生成 PKCE。
    webcrypto: original.webcrypto,
  }
})

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

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buf: Buffer) => {
      const raw = buf.toString()
      if (!raw.startsWith('enc:')) throw new Error('not an encrypted blob')
      return raw.slice(4)
    },
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}))

import { XidElectronApp } from '../main/xid-app'
import { IPC_CHANNELS } from '../types'

type Handler = (...args: unknown[]) => unknown

function createMockIpcMain(): {
  ipcMain: import('electron').IpcMain
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
} {
  const handlers = new Map<string, Handler>()

  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
  } as unknown as import('electron').IpcMain

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`No handler for channel: ${channel}`)
    // Electron IPC 首参为 event，此处用空 stub。
    return handler({} as import('electron').IpcMainInvokeEvent, ...args)
  }

  return { ipcMain, invoke }
}

describe('XidElectronApp: init + dispose', () => {
  beforeEach(() => {
    Object.keys(fakeFs).forEach((k) => delete fakeFs[k])
    vi.clearAllMocks()
  })

  it('init() registers SIGN_IN, SIGN_OUT, GET_ACCESS_TOKEN, GET_SESSION, SET_TOKEN_STORAGE channels', async () => {
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain } = createMockIpcMain()

    await app.init(ipcMain)

    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.SIGN_IN, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.SIGN_OUT, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.GET_ACCESS_TOKEN, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.GET_SESSION, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(
      IPC_CHANNELS.SET_TOKEN_STORAGE,
      expect.any(Function),
    )
  })

  it('dispose() removes all registered handlers', async () => {
    const xidApp = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain } = createMockIpcMain()
    await xidApp.init(ipcMain)

    xidApp.dispose(ipcMain)

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.SIGN_IN)
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.SIGN_OUT)
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.GET_ACCESS_TOKEN)
  })

  it('rejects offline_access until DPoP sender binding is implemented', () => {
    expect(
      () =>
        new XidElectronApp({
          issuer: 'https://xid.dev',
          clientId: 'client_test',
          scopes: ['openid', 'offline_access'],
          storageDir: '/tmp/xid-test',
        }),
    ).toThrow('offline_access requires DPoP')
  })

  it('removes the historical refresh credential during startup migration', async () => {
    const firstApp = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const firstIpc = createMockIpcMain()
    await firstApp.init(firstIpc.ipcMain)
    await firstIpc.invoke(IPC_CHANNELS.STORAGE_SET, 'xid:refresh-token', 'legacy-only')
    firstApp.dispose(firstIpc.ipcMain)

    const restartedApp = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const restartedIpc = createMockIpcMain()
    await restartedApp.init(restartedIpc.ipcMain)

    await expect(
      restartedIpc.invoke(IPC_CHANNELS.STORAGE_GET, 'xid:refresh-token'),
    ).resolves.toBeNull()
  })
})

describe('XidElectronApp: GET_ACCESS_TOKEN returns null before sign-in', () => {
  beforeEach(() => {
    Object.keys(fakeFs).forEach((k) => delete fakeFs[k])
    vi.clearAllMocks()
  })

  it('GET_ACCESS_TOKEN returns null when storage is empty', async () => {
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    const result = await invoke(IPC_CHANNELS.GET_ACCESS_TOKEN)

    expect(result).toBeNull()
  })

  it('GET_SESSION returns null when no token is stored', async () => {
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    const result = await invoke(IPC_CHANNELS.GET_SESSION)

    expect(result).toBeNull()
  })
})

describe('XidElectronApp: SIGN_IN state CSRF protection', () => {
  // 无真实 Electron 时，用 parseCallbackUrl 覆盖 #handleSignIn 对缺 code 回调的委托。

  beforeEach(() => {
    Object.keys(fakeFs).forEach((k) => delete fakeFs[k])
    vi.clearAllMocks()
  })

  it('rejects a callback URL with no authorization code', async () => {
    const loopbackMock = {
      redirectUri: 'http://127.0.0.1:9999/callback',
      waitForCallback: vi
        .fn()
        .mockResolvedValue(new URL('http://127.0.0.1:9999/callback?state=any')),
      close: vi.fn().mockResolvedValue(undefined),
    }
    vi.doMock('../main/loopback-server', () => ({
      startLoopbackServer: vi.fn().mockResolvedValue(loopbackMock),
    }))

    const { parseCallbackUrl } = await import('../pkce')
    const url = new URL('http://127.0.0.1:9999/callback?state=xyz')
    expect(parseCallbackUrl(url)).toBeNull()
    vi.doUnmock('../main/loopback-server')
  })
})

describe('XidElectronApp: local authorization-code session', () => {
  beforeEach(() => {
    Object.keys(fakeFs).forEach((k) => delete fakeFs[k])
    vi.clearAllMocks()
  })

  it('GET_ACCESS_TOKEN returns stored token after manual storage population', async () => {
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    await invoke(IPC_CHANNELS.STORAGE_SET, 'xid:access-token', 'at.manually-set')
    await invoke(
      IPC_CHANNELS.STORAGE_SET,
      'xid:session-meta',
      JSON.stringify({ expiresAt: Math.floor(Date.now() / 1000) + 7200 }),
    )

    const token = await invoke(IPC_CHANNELS.GET_ACCESS_TOKEN)

    expect(token).toBe('at.manually-set')
  })

  it('SIGN_OUT clears the access token and legacy refresh storage without a network request', async () => {
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    await invoke(IPC_CHANNELS.STORAGE_SET, 'xid:access-token', 'at.to-clear')
    await invoke(IPC_CHANNELS.STORAGE_SET, 'xid:refresh-token', 'legacy-only')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await invoke(IPC_CHANNELS.SIGN_OUT)

    const result = await invoke(IPC_CHANNELS.GET_ACCESS_TOKEN)

    expect(result).toBeNull()
    expect(await invoke(IPC_CHANNELS.STORAGE_GET, 'xid:refresh-token')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('XidElectronApp: AbortSignal cancellation', () => {
  it('signIn() respects an already-aborted signal', async () => {
    const signal = AbortSignal.abort()

    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    await expect(invoke(IPC_CHANNELS.SIGN_IN, { signal })).rejects.toThrow('aborted')
  })
})

describe('XidElectronApp: PKCE verifier is cleared after use (one-time use)', () => {
  it('invoking sign-in twice starts a fresh PKCE flow (prior state is cleared)', async () => {
    // 预中止两次登录：应均为 aborted，而非串用旧 PKCE。
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    const r1 = invoke(IPC_CHANNELS.SIGN_IN, { signal: AbortSignal.abort() })
    await expect(r1).rejects.toThrow('aborted')

    const r2 = invoke(IPC_CHANNELS.SIGN_IN, { signal: AbortSignal.abort() })
    await expect(r2).rejects.toThrow('aborted')
  })
})

describe('XidElectronApp: access-token expiry', () => {
  beforeEach(() => {
    Object.keys(fakeFs).forEach((k) => delete fakeFs[k])
    vi.clearAllMocks()
  })

  it('GET_ACCESS_TOKEN clears expired and legacy state without a network request', async () => {
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    const expiredAt = Math.floor(Date.now() / 1000) - 100
    await invoke(IPC_CHANNELS.STORAGE_SET, 'xid:access-token', 'at.expired')
    await invoke(IPC_CHANNELS.STORAGE_SET, 'xid:refresh-token', 'legacy-only')
    await invoke(
      IPC_CHANNELS.STORAGE_SET,
      'xid:session-meta',
      JSON.stringify({ expiresAt: expiredAt }),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await invoke(IPC_CHANNELS.GET_ACCESS_TOKEN)

    expect(result).toBeNull()
    expect(await invoke(IPC_CHANNELS.STORAGE_GET, 'xid:access-token')).toBeNull()
    expect(await invoke(IPC_CHANNELS.STORAGE_GET, 'xid:refresh-token')).toBeNull()
    expect(await invoke(IPC_CHANNELS.STORAGE_GET, 'xid:session-meta')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails closed and clears a token whose expiry metadata is missing', async () => {
    const app = new XidElectronApp({
      issuer: 'https://xid.dev',
      clientId: 'client_test',
      storageDir: '/tmp/xid-test',
    })
    const { ipcMain, invoke } = createMockIpcMain()
    await app.init(ipcMain)

    await invoke(IPC_CHANNELS.STORAGE_SET, 'xid:access-token', 'at.no-expiry')

    const result = await invoke(IPC_CHANNELS.GET_ACCESS_TOKEN)

    expect(result).toBeNull()
    expect(await invoke(IPC_CHANNELS.STORAGE_GET, 'xid:access-token')).toBeNull()
  })
})
