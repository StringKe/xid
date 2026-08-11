import { I18nProvider } from '@lingui/react'
import { i18n } from '@xid-kit/i18n'
import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  detectLocale,
  getEnglishCatalog,
  loadCatalog,
  persistLocale,
  type SupportedLocale,
} from './locale'

type LocaleContextValue = {
  locale: SupportedLocale
  isChanging: boolean
  setLocale: (locale: SupportedLocale) => Promise<void>
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export type LocaleProviderProps = {
  children: ReactNode
  initialLocale: SupportedLocale
}

function activateCatalog(
  locale: SupportedLocale,
  messages: Record<string, string | string[]>,
): void {
  i18n.load(locale, messages)
  i18n.activate(locale)
}

// 英文首屏同步激活,跳过 await 微任务以缩短 LCP。
export function activateEnglishLocale(): SupportedLocale {
  activateCatalog('en', getEnglishCatalog())
  return 'en'
}

export async function loadInitialLocale(): Promise<SupportedLocale> {
  const locale = detectLocale()
  const messages = await loadCatalog(locale)
  activateCatalog(locale, messages)
  return locale
}

export function LocaleProvider({ children, initialLocale }: LocaleProviderProps): ReactNode {
  const [locale, setLocaleState] = useState<SupportedLocale>(initialLocale)
  const [isChanging, setIsChanging] = useState(false)

  async function setLocale(localeValue: SupportedLocale): Promise<void> {
    if (localeValue === locale) return
    setIsChanging(true)
    try {
      const messages = await loadCatalog(localeValue)
      i18n.load(localeValue, messages)
      i18n.activate(localeValue)
      persistLocale(localeValue)
      setLocaleState(localeValue)
      globalThis.document?.documentElement.setAttribute('lang', localeValue)
    } finally {
      setIsChanging(false)
    }
  }

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, isChanging, setLocale }),
    [locale, isChanging],
  )

  return (
    <LocaleContext value={value}>
      <I18nProvider i18n={i18n} key={locale}>
        {children}
      </I18nProvider>
    </LocaleContext>
  )
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext)
  if (!context) throw new Error('useLocale must be used within LocaleProvider')
  return context
}
