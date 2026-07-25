import { i18n } from '@lingui/core'
import type { XidErrorCode } from '@xid-kit/types'
import { errorMessages } from './messages'

// 运行时 i18n 实例。激活 locale 后 import compile 产物再 i18n.load。
// 运行时 import 的是 compile 产物,不是 .po。见 i18n-lingui rule。
export { i18n }

// locale 检测优先级:?locale= -> user.locale -> Accept-Language -> 租户默认 -> en
export const SUPPORTED_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/**
 * 激活指定 locale,同时加载 compile 产物。
 * 调用方负责在外部 import catalog messages 再传入。
 */
export function activateLocale(
  locale: SupportedLocale,
  messages: Record<string, string | string[]>,
): void {
  i18n.load(locale, messages)
  i18n.activate(locale)
}

/**
 * 将 XidErrorCode 渲染为当前 locale 的用户可见错误消息。
 * 依赖 i18n 已通过 activateLocale 激活,否则回落英文源文本。
 */
export function renderErrorMessage(code: XidErrorCode): string {
  const descriptor = errorMessages[code]
  return i18n._(descriptor)
}

export { errorMessages, protocolErrorPageMessages } from './messages'
export type { ErrorMessages } from './messages'
