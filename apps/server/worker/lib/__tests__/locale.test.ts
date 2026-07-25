// resolveLocale 优先级测试:?locale= -> user -> Accept-Language -> 租户默认 -> en。
// 见 i18n-lingui rule、07 章 locale 检测优先级。纯逻辑,不依赖 lingui 运行时。

import { describe, it, expect } from 'vitest'
import { isSupportedLocale, resolveLocale } from '../locale'

describe('resolveLocale: 优先级', () => {
  it('queryLocale 命中时优先于其它所有源', () => {
    const locale = resolveLocale({
      queryLocale: 'ja',
      userLocale: 'ko',
      acceptLanguage: 'fr',
      tenantDefault: 'de',
    })
    expect(locale).toBe('ja')
  })

  it('queryLocale 缺失时回退 userLocale', () => {
    const locale = resolveLocale({ userLocale: 'ko', acceptLanguage: 'fr', tenantDefault: 'de' })
    expect(locale).toBe('ko')
  })

  it('query/user 缺失时回退 Accept-Language 首个匹配', () => {
    const locale = resolveLocale({ acceptLanguage: 'zh-Hans,en;q=0.8', tenantDefault: 'de' })
    expect(locale).toBe('zh-Hans')
  })

  it('Accept-Language 全不支持时跳到租户默认', () => {
    const locale = resolveLocale({ acceptLanguage: 'ru,it;q=0.5', tenantDefault: 'de' })
    expect(locale).toBe('de')
  })

  it('所有源缺失或不支持时回退 en', () => {
    expect(resolveLocale({})).toBe('en')
    expect(resolveLocale({ queryLocale: 'xx', userLocale: 'yy', acceptLanguage: 'zz' })).toBe('en')
  })
})

describe('resolveLocale: BCP 47 fallback', () => {
  it('中文区域标签回落到 zh-Hans', () => {
    expect(resolveLocale({ queryLocale: 'zh-CN' })).toBe('zh-Hans')
    expect(resolveLocale({ acceptLanguage: 'zh-CN,en;q=0.8' })).toBe('zh-Hans')
  })

  it('区域标签按语言子标签回落到已支持 locale', () => {
    expect(resolveLocale({ acceptLanguage: 'fr-FR,en;q=0.8' })).toBe('fr')
  })

  it('葡萄牙语区域标签回落到 pt-BR', () => {
    expect(resolveLocale({ userLocale: 'pt-PT' })).toBe('pt-BR')
  })

  it('Accept-Language 忽略 q 值按出现顺序取首个支持项', () => {
    expect(resolveLocale({ acceptLanguage: 'en;q=0.1,ja;q=0.9' })).toBe('en')
  })

  it('null/undefined 源安全跳过', () => {
    expect(resolveLocale({ queryLocale: null, userLocale: undefined, acceptLanguage: null })).toBe(
      'en',
    )
  })
})

describe('isSupportedLocale', () => {
  it('已知 BCP 47 标签为真', () => {
    expect(isSupportedLocale('pt-BR')).toBe(true)
    expect(isSupportedLocale('en')).toBe(true)
  })

  it('未知标签为假', () => {
    expect(isSupportedLocale('zh-CN')).toBe(false)
    expect(isSupportedLocale('xx')).toBe(false)
  })
})
