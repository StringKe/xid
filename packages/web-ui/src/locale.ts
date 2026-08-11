import { messages as enMessages } from '@xid-kit/i18n/locales/en/messages.mjs'

// SUPPORTED_LOCALES 本地声明(与 @xid-kit/i18n 契约对齐),不从该包 index import:
// index 经 messages.ts 拉入 @lingui/core/macro,node 测试池无 babel plugin 会 ESM 解析失败。
// 浏览器优先级:?locale= -> localStorage -> navigator.languages -> en。
export const SUPPORTED_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const DEFAULT_LOCALE: SupportedLocale = 'en'
const SUPPORTED = new Set<string>(SUPPORTED_LOCALES)
const LANGUAGE_FALLBACKS: Record<string, SupportedLocale> = {
  zh: 'zh-Hans',
  pt: 'pt-BR',
}
const LOCALE_STORAGE_KEY = 'xid.locale'

export function isSupportedLocale(tag: string): tag is SupportedLocale {
  return SUPPORTED.has(tag)
}

function exactSupported(tag: string | null | undefined): SupportedLocale | undefined {
  return tag && SUPPORTED.has(tag) ? (tag as SupportedLocale) : undefined
}

function languageFallback(tag: string | null | undefined): SupportedLocale | undefined {
  if (!tag) return undefined
  const language = tag.split('-')[0]?.toLowerCase()
  return exactSupported(language) ?? LANGUAGE_FALLBACKS[language ?? '']
}

function supportedLocale(tag: string | null | undefined): SupportedLocale | undefined {
  return exactSupported(tag) ?? languageFallback(tag)
}

function fromNavigator(): SupportedLocale | undefined {
  const languages = globalThis.navigator?.languages ?? []
  for (const tag of languages) {
    const match = supportedLocale(tag)
    if (match) return match
  }
  return undefined
}

function fromStorage(): SupportedLocale | undefined {
  try {
    return supportedLocale(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return undefined
  }
}

function fromQuery(): SupportedLocale | undefined {
  const search = globalThis.location?.search ?? ''
  const value = new URLSearchParams(search).get('locale')
  return supportedLocale(value)
}

export function detectLocale(): SupportedLocale {
  return fromQuery() ?? fromStorage() ?? fromNavigator() ?? DEFAULT_LOCALE
}

export function persistLocale(locale: SupportedLocale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // 隐私模式等 localStorage 不可用时静默,locale 仍生效本会话。
  }
}

// compileNamespace:'es' 产物为 export const messages,与 worker normalizeCatalog 对齐。
function normalizeCatalog(mod: unknown): Record<string, string | string[]> {
  const candidate = mod as { messages?: unknown; default?: { messages?: unknown } }
  const messages = candidate.messages ?? candidate.default?.messages
  return (messages as Record<string, string | string[]>) ?? {}
}

// en 静态编入主包,避免首屏再拉 messages chunk(移动端 LCP)。
const EN_CATALOG = normalizeCatalog({ messages: enMessages })

export function getEnglishCatalog(): Record<string, string | string[]> {
  return EN_CATALOG
}

// 非 en 按 locale 动态 import,Vite 静态分析逐个分块。
const CATALOG_LOADERS: Record<
  Exclude<SupportedLocale, 'en'>,
  () => Promise<Record<string, string | string[]>>
> = {
  'zh-Hans': () => import('@xid-kit/i18n/locales/zh-Hans/messages.mjs').then(normalizeCatalog),
  ja: () => import('@xid-kit/i18n/locales/ja/messages.mjs').then(normalizeCatalog),
  ko: () => import('@xid-kit/i18n/locales/ko/messages.mjs').then(normalizeCatalog),
  fr: () => import('@xid-kit/i18n/locales/fr/messages.mjs').then(normalizeCatalog),
  de: () => import('@xid-kit/i18n/locales/de/messages.mjs').then(normalizeCatalog),
  es: () => import('@xid-kit/i18n/locales/es/messages.mjs').then(normalizeCatalog),
  'pt-BR': () => import('@xid-kit/i18n/locales/pt-BR/messages.mjs').then(normalizeCatalog),
}

export async function loadCatalog(
  locale: SupportedLocale,
): Promise<Record<string, string | string[]>> {
  if (locale === 'en') return EN_CATALOG
  return CATALOG_LOADERS[locale]()
}
