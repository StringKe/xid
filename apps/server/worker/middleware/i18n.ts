// 每请求独立 Lingui 实例,防 isolate 内并发覆盖 locale;catalog 可共享,activate 仅限请求实例。

import { setupI18n } from '@lingui/core'
import type { I18n } from '@lingui/core'
import type { MiddlewareHandler } from 'hono'
import { resolveLocale } from '../lib/locale'
import type { WorkerLocale } from '../lib/locale'
import type { XidHonoEnv } from '../lib/types'

type Catalog = Readonly<Record<string, string | string[]>>
const catalogPromises = new Map<WorkerLocale, Promise<Catalog>>()

// ESM catalog 归一:compile 产物 compileNamespace:'es' 为 export const messages。
type CompiledCatalog = { messages: Record<string, string | string[]> }

function normalizeCatalog(mod: unknown): Catalog {
  const candidate = mod as { messages?: unknown; default?: { messages?: unknown } }
  const messages = candidate.messages ?? candidate.default?.messages
  return Object.freeze({ ...((messages as CompiledCatalog['messages']) ?? {}) })
}

// 各 locale catalog 静态动态导入(Vite 可静态分析逐个分块)。
// en 作为 sourceLocale,lingui v6 hash id 必须从 catalog 取映射,不能传空表。
const CATALOG_LOADERS: Record<WorkerLocale, () => Promise<Catalog>> = {
  en: () => import('@xid-kit/i18n/locales/en/messages.mjs').then(normalizeCatalog),
  'zh-Hans': () => import('@xid-kit/i18n/locales/zh-Hans/messages.mjs').then(normalizeCatalog),
  ja: () => import('@xid-kit/i18n/locales/ja/messages.mjs').then(normalizeCatalog),
  ko: () => import('@xid-kit/i18n/locales/ko/messages.mjs').then(normalizeCatalog),
  fr: () => import('@xid-kit/i18n/locales/fr/messages.mjs').then(normalizeCatalog),
  de: () => import('@xid-kit/i18n/locales/de/messages.mjs').then(normalizeCatalog),
  es: () => import('@xid-kit/i18n/locales/es/messages.mjs').then(normalizeCatalog),
  'pt-BR': () => import('@xid-kit/i18n/locales/pt-BR/messages.mjs').then(normalizeCatalog),
}

function loadCatalog(locale: WorkerLocale): Promise<Catalog> {
  let catalog = catalogPromises.get(locale)
  if (catalog === undefined) {
    catalog = CATALOG_LOADERS[locale]()
    catalogPromises.set(locale, catalog)
  }
  return catalog
}

export async function createRequestI18n(locale: WorkerLocale): Promise<I18n> {
  const instance = setupI18n()
  instance.load(locale, await loadCatalog(locale))
  instance.activate(locale)
  return instance
}

// 激活本请求 locale:解析优先级 -> 确保 catalog -> i18n.activate -> 注入 c.set('locale')。
// 此中间件在 session 之前运行,只用 ?locale= 与 Accept-Language;user.locale / 租户默认
// 由已登录上下文的后续逻辑用 resolveLocale 叠加(TenantPolicy 暂无 locale 字段,不臆造)。
export const i18nMiddleware: MiddlewareHandler<XidHonoEnv> = async (c, next) => {
  const locale = resolveLocale({
    queryLocale: c.req.query('locale'),
    acceptLanguage: c.req.header('accept-language'),
  })
  c.set('i18n', await createRequestI18n(locale))
  c.set('locale', locale)
  await next()
}
