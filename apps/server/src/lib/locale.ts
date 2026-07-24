import { messages as enMessages } from '@xid-kit/i18n/locales/en/messages.mjs'

// SPA locale 解析 + catalog 加载。与 worker/lib/locale.ts 同源逻辑(BCP 47 精确匹配 + 语言 fallback),
// 但浏览器侧的优先级是:?locale= -> 已存 user 偏好(localStorage)-> navigator.languages -> en。
// catalog 经 @xid-kit/i18n/locales/{locale}/messages.mjs 动态 import(与 worker i18n 中间件同款分块策略)。
//
// SUPPORTED_LOCALES 本地声明(与 @xid-kit/i18n SUPPORTED_LOCALES 契约对齐),不从该包 import:
// 该包 index 经 messages.ts 拉入 @lingui/core/macro,node 测试池无 lingui babel plugin 会 ESM 解析失败
// (与 worker/lib/locale.ts 同款隔离策略)。catalog 仍按子路径动态 import,不触达 macro。

// locale 支持列表(BCP 47 标签),与 worker/i18n 全套对齐。
export const SUPPORTED_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const DEFAULT_LOCALE: SupportedLocale = 'en'
const SUPPORTED = new Set<string>(SUPPORTED_LOCALES)
const LANGUAGE_FALLBACKS: Record<string, SupportedLocale> = {
  zh: 'zh-Hans',
  pt: 'pt-BR',
}
// 用户手动选择 locale 的持久化键(覆盖 navigator 检测)。
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

// navigator.languages 取第一个匹配项,先精确匹配,再按语言子标签 fallback。
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

// 浏览器侧 locale 优先级解析,缺失全部回落 en(不显示 key 名)。
export function detectLocale(): SupportedLocale {
  return fromQuery() ?? fromStorage() ?? fromNavigator() ?? DEFAULT_LOCALE
}

export function persistLocale(locale: SupportedLocale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // localStorage 不可用(隐私模式)时静默:locale 仍生效本次会话,不阻断。
  }
}

// ESM catalog 归一(compile 产物 compileNamespace:'es' 为 export const messages),与 worker normalizeCatalog 对齐。
function normalizeCatalog(mod: unknown): Record<string, string | string[]> {
  const candidate = mod as { messages?: unknown; default?: { messages?: unknown } }
  const messages = candidate.messages ?? candidate.default?.messages
  return (messages as Record<string, string | string[]>) ?? {}
}

// en catalog 静态编入主包,避免首屏多一次 messages chunk 往返(移动端 LCP)。
const EN_CATALOG = normalizeCatalog({ messages: enMessages })

export function getEnglishCatalog(): Record<string, string | string[]> {
  return EN_CATALOG
}

// 各非 en locale 的 catalog 动态 import(Vite 静态分析逐个分块)。
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

// 加载指定 locale 的 compile 产物(含 en sourceLocale 的 id -> 源文本映射)。
export async function loadCatalog(
  locale: SupportedLocale,
): Promise<Record<string, string | string[]>> {
  if (locale === 'en') return EN_CATALOG
  return CATALOG_LOADERS[locale]()
}
