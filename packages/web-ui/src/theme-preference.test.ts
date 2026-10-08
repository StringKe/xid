import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_STORAGE_KEY,
  persistThemeMode,
  readThemeMode,
  resolveThemeScheme,
} from './theme-preference'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme preference', () => {
  it('reads a stored explicit mode from xid.theme', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [THEME_STORAGE_KEY]: 'dark' }))

    expect(readThemeMode()).toBe('dark')
  })

  it('falls back to system for an unknown stored value or unavailable storage', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [THEME_STORAGE_KEY]: 'sepia' }))
    const unknown = readThemeMode()
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    const blocked = readThemeMode()

    expect(unknown).toBe('system')
    expect(blocked).toBe('system')
  })

  it('stores explicit modes and clears the key when returning to system', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)

    persistThemeMode('light')
    const afterLight = storage.getItem(THEME_STORAGE_KEY)
    persistThemeMode('system')

    expect(afterLight).toBe('light')
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('resolves system mode from the OS preference and keeps explicit modes', () => {
    expect(resolveThemeScheme('system', true)).toBe('dark')
    expect(resolveThemeScheme('system', false)).toBe('light')
    expect(resolveThemeScheme('light', true)).toBe('light')
    expect(resolveThemeScheme('dark', false)).toBe('dark')
  })
})
