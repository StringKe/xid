import type { Messages } from '@lingui/core'
import type { SiteLocale } from './site-locale'

function normalizeCatalog(module: unknown): Messages {
  const catalog = module as { messages?: Messages; default?: { messages?: Messages } }
  return catalog.messages ?? catalog.default?.messages ?? {}
}

const CATALOG_LOADERS: Readonly<Record<SiteLocale, () => Promise<Messages>>> = {
  en: () => import('@xid-kit/i18n/locales/en/messages.mjs').then(normalizeCatalog),
  'zh-Hans': () => import('@xid-kit/i18n/locales/zh-Hans/messages.mjs').then(normalizeCatalog),
  ja: () => import('@xid-kit/i18n/locales/ja/messages.mjs').then(normalizeCatalog),
  ko: () => import('@xid-kit/i18n/locales/ko/messages.mjs').then(normalizeCatalog),
  fr: () => import('@xid-kit/i18n/locales/fr/messages.mjs').then(normalizeCatalog),
  de: () => import('@xid-kit/i18n/locales/de/messages.mjs').then(normalizeCatalog),
  es: () => import('@xid-kit/i18n/locales/es/messages.mjs').then(normalizeCatalog),
  'pt-BR': () => import('@xid-kit/i18n/locales/pt-BR/messages.mjs').then(normalizeCatalog),
}

export function loadSiteCatalog(locale: SiteLocale): Promise<Messages> {
  return CATALOG_LOADERS[locale]()
}
