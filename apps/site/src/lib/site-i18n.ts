import { setupI18n } from '@lingui/core'
import type { I18n, MessageDescriptor, Messages } from '@lingui/core'
import { messages as deMessages } from '@xid-kit/i18n/locales/de/messages.mjs'
import { messages as enMessages } from '@xid-kit/i18n/locales/en/messages.mjs'
import { messages as esMessages } from '@xid-kit/i18n/locales/es/messages.mjs'
import { messages as frMessages } from '@xid-kit/i18n/locales/fr/messages.mjs'
import { messages as jaMessages } from '@xid-kit/i18n/locales/ja/messages.mjs'
import { messages as koMessages } from '@xid-kit/i18n/locales/ko/messages.mjs'
import { messages as ptBrMessages } from '@xid-kit/i18n/locales/pt-BR/messages.mjs'
import { messages as zhHansMessages } from '@xid-kit/i18n/locales/zh-Hans/messages.mjs'
import { getSiteLocale } from './site-locale'
import type { SiteLocale } from './site-locale'

const CATALOGS: Readonly<Record<SiteLocale, Messages>> = {
  en: enMessages,
  'zh-Hans': zhHansMessages,
  ja: jaMessages,
  ko: koMessages,
  fr: frMessages,
  de: deMessages,
  es: esMessages,
  'pt-BR': ptBrMessages,
}

const INSTANCES = new Map<SiteLocale, I18n>()

export function getSiteI18n(pathname: string): {
  locale: SiteLocale
  i18n: I18n
} {
  const locale = getSiteLocale(pathname)
  const cached = INSTANCES.get(locale)
  if (cached) return { locale, i18n: cached }

  const i18n = setupI18n({
    locale,
    messages: { [locale]: CATALOGS[locale] },
  })
  INSTANCES.set(locale, i18n)
  return { locale, i18n }
}

export function translateSiteMessage(
  pathname: string,
  descriptor: MessageDescriptor,
  values?: Record<string, unknown>,
): string {
  const { i18n } = getSiteI18n(pathname)
  return values === undefined ? i18n._(descriptor) : i18n._({ ...descriptor, values })
}
