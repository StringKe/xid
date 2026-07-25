// locale 解析(纯逻辑,不依赖 @xid-kit/i18n 运行时 / lingui macro,便于单测)。
// 优先级(见 i18n-lingui rule、07 章):?locale= -> user.locale -> Accept-Language -> 租户默认 -> en。
// 支持标签用 BCP 47,先精确匹配,再按语言子标签 fallback。

export const SUPPORTED_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const
export type WorkerLocale = (typeof SUPPORTED_LOCALES)[number]

const DEFAULT_LOCALE: WorkerLocale = 'en'
const SUPPORTED = new Set<string>(SUPPORTED_LOCALES)
const LANGUAGE_FALLBACKS: Record<string, WorkerLocale> = {
  zh: 'zh-Hans',
  pt: 'pt-BR',
}

function exactSupported(tag: string | undefined | null): WorkerLocale | undefined {
  if (tag && SUPPORTED.has(tag)) return tag as WorkerLocale
  return undefined
}

function languageFallback(tag: string | undefined | null): WorkerLocale | undefined {
  if (!tag) return undefined
  const language = tag.split('-')[0]?.toLowerCase()
  return exactSupported(language) ?? LANGUAGE_FALLBACKS[language ?? '']
}

function supportedLocale(tag: string | undefined | null): WorkerLocale | undefined {
  return exactSupported(tag) ?? languageFallback(tag)
}

// Accept-Language 取第一个能匹配的标签(忽略 q 值排序,按出现顺序)。
function fromAcceptLanguage(header: string | undefined | null): WorkerLocale | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim()
    const match = supportedLocale(tag)
    if (match) return match
  }
  return undefined
}

// locale 优先级解析。各源未命中按顺序回退,最终 en(缺失不显示 key 名)。
export function resolveLocale(input: {
  queryLocale?: string | null
  userLocale?: string | null
  acceptLanguage?: string | null
  tenantDefault?: string | null
}): WorkerLocale {
  return (
    supportedLocale(input.queryLocale) ??
    supportedLocale(input.userLocale) ??
    fromAcceptLanguage(input.acceptLanguage) ??
    supportedLocale(input.tenantDefault) ??
    DEFAULT_LOCALE
  )
}

export function isSupportedLocale(tag: string): tag is WorkerLocale {
  return SUPPORTED.has(tag)
}
