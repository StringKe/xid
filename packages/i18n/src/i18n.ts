import { i18n } from '@lingui/core'
import type { XidErrorCode } from '@xid-kit/types'
import { errorMessages } from './messages'

// 运行时加载 compile 产物,切勿直接 import .po。
export { i18n }

export const SUPPORTED_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** 调用方须自行 import compile catalog 后传入。 */
export function activateLocale(
  locale: SupportedLocale,
  messages: Record<string, string | string[]>,
): void {
  i18n.load(locale, messages)
  i18n.activate(locale)
}

/** 须先 activateLocale;未激活时回落英文源文本。 */
export function renderErrorMessage(code: XidErrorCode): string {
  const descriptor = errorMessages[code]
  return i18n._(descriptor)
}

export { errorMessages, protocolErrorPageMessages } from './messages'
export type { ErrorMessages } from './messages'
