// locale 测试:detectLocale 优先级(query -> storage -> navigator -> en)与 isSupportedLocale 精确匹配。
// node 环境无 window,逐项 stub globalThis.location / localStorage / navigator。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectLocale, isSupportedLocale, persistLocale } from '../locale'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubEnv(input: {
  search?: string
  stored?: string | null
  languages?: readonly string[]
  onSetItem?: (key: string, value: string) => void
}): void {
  vi.stubGlobal('location', { search: input.search ?? '', origin: 'https://t.xid.dev' })
  vi.stubGlobal('localStorage', {
    getItem: () => input.stored ?? null,
    setItem: (key: string, value: string) => input.onSetItem?.(key, value),
  })
  vi.stubGlobal('navigator', { languages: input.languages ?? [] })
}

describe('isSupportedLocale', () => {
  it('精确匹配 BCP 47 支持标签', () => {
    expect(isSupportedLocale('zh-Hans')).toBe(true)
    expect(isSupportedLocale('pt-BR')).toBe(true)
  })

  it('isSupportedLocale 只判断已注册标签', () => {
    expect(isSupportedLocale('zh-CN')).toBe(false)
    expect(isSupportedLocale('pt')).toBe(false)
  })
})

describe('detectLocale', () => {
  it('?locale= 优先级最高', () => {
    stubEnv({ search: '?locale=ja', stored: 'fr', languages: ['de'] })
    expect(detectLocale()).toBe('ja')
  })

  it('无 query 时用 localStorage 偏好', () => {
    stubEnv({ stored: 'ko', languages: ['de'] })
    expect(detectLocale()).toBe('ko')
  })

  it('无 query/storage 时取 navigator 首个精确匹配', () => {
    stubEnv({ stored: null, languages: ['zh-CN', 'zh-Hans', 'en'] })
    expect(detectLocale()).toBe('zh-Hans')
  })

  it('navigator 中文区域标签回落到 zh-Hans', () => {
    stubEnv({ stored: null, languages: ['zh-CN', 'en-US'] })
    expect(detectLocale()).toBe('zh-Hans')
  })

  it('区域标签按语言子标签回落到已支持 locale', () => {
    stubEnv({ stored: null, languages: ['fr-FR', 'en-US'] })
    expect(detectLocale()).toBe('fr')
  })

  it('葡萄牙语区域标签回落到 pt-BR', () => {
    stubEnv({ stored: null, languages: ['pt-PT', 'en-US'] })
    expect(detectLocale()).toBe('pt-BR')
  })

  it('全部缺失回落 en', () => {
    stubEnv({ stored: null, languages: ['it'] })
    expect(detectLocale()).toBe('en')
  })
})

describe('persistLocale', () => {
  it('持久化用户选择的 locale', () => {
    const writes: Array<[string, string]> = []
    stubEnv({ onSetItem: (key, value) => writes.push([key, value]) })

    persistLocale('zh-Hans')

    expect(writes).toEqual([['xid.locale', 'zh-Hans']])
  })
})
