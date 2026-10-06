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
  failedLocale: SupportedLocale | null
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

// 非英文 catalog 是带 hash 的动态 chunk,发布窗口或网络中断时可能加载失败:回退英文保证挂载,
// 不改写已保存的语言偏好,下次加载仍按用户选择重试。
export async function loadInitialLocale(): Promise<SupportedLocale> {
  const locale = detectLocale()
  try {
    activateCatalog(locale, await loadCatalog(locale))
    return locale
  } catch (error) {
    console.error('Locale catalog failed to load; falling back to English', { locale, error })
    return activateEnglishLocale()
  }
}

// Core 与 Console 入口共用:英文同步挂载,其他语言先激活 catalog 再挂载,避免首帧英文闪烁。
export function startWithLocale(mount: (locale: SupportedLocale) => void): void {
  if (detectLocale() === 'en') {
    mount(activateEnglishLocale())
    return
  }
  void loadInitialLocale().then(mount)
}

export function LocaleProvider({ children, initialLocale }: LocaleProviderProps): ReactNode {
  const [locale, setLocaleState] = useState<SupportedLocale>(initialLocale)
  const [isChanging, setIsChanging] = useState(false)
  const [failedLocale, setFailedLocale] = useState<SupportedLocale | null>(null)

  async function setLocale(localeValue: SupportedLocale): Promise<void> {
    if (localeValue === locale) return
    setIsChanging(true)
    setFailedLocale(null)
    try {
      const messages = await loadCatalog(localeValue)
      i18n.load(localeValue, messages)
      i18n.activate(localeValue)
      persistLocale(localeValue)
      setLocaleState(localeValue)
      globalThis.document?.documentElement.setAttribute('lang', localeValue)
    } catch (error) {
      console.error('Locale catalog failed to load', { locale: localeValue, error })
      setFailedLocale(localeValue)
    } finally {
      setIsChanging(false)
    }
  }

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, isChanging, failedLocale, setLocale }),
    [locale, isChanging, failedLocale],
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
