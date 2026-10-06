import { beforeEach, describe, expect, it, vi } from 'vitest'

const localeMocks = vi.hoisted(() => ({
  detectLocale: vi.fn<() => string>(),
  loadCatalog: vi.fn<(locale: string) => Promise<Record<string, string>>>(),
  persistLocale: vi.fn<(locale: string) => void>(),
  activate: vi.fn<(locale: string) => void>(),
}))

vi.mock('@xid-kit/i18n', () => ({
  i18n: { load: vi.fn<() => void>(), activate: localeMocks.activate },
}))

vi.mock('./locale', () => ({
  detectLocale: localeMocks.detectLocale,
  loadCatalog: localeMocks.loadCatalog,
  persistLocale: localeMocks.persistLocale,
  getEnglishCatalog: () => ({}),
}))

import { startWithLocale } from './locale-context'

describe('startWithLocale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('mounts in English when the detected catalog chunk fails to load', async () => {
    localeMocks.detectLocale.mockReturnValue('ja')
    localeMocks.loadCatalog.mockRejectedValue(new Error('chunk missing'))
    const mount = vi.fn<(locale: string) => void>()

    startWithLocale(mount)
    await vi.waitFor(() => expect(mount).toHaveBeenCalled())

    expect(mount).toHaveBeenCalledWith('en')
    expect(localeMocks.activate).toHaveBeenLastCalledWith('en')
    expect(localeMocks.persistLocale).not.toHaveBeenCalled()
  })

  it('mounts with the detected locale once its catalog loads', async () => {
    localeMocks.detectLocale.mockReturnValue('ja')
    localeMocks.loadCatalog.mockResolvedValue({})
    const mount = vi.fn<(locale: string) => void>()

    startWithLocale(mount)
    await vi.waitFor(() => expect(mount).toHaveBeenCalled())

    expect(mount).toHaveBeenCalledWith('ja')
  })
})
