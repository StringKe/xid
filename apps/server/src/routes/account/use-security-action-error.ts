// 账户门户写操作的错误文案:按错误码渲染本地化描述;用户关掉重新验证弹窗时返回 null,不显示错误。

import { useLingui } from '@lingui/react/macro'
import type { XidError } from '@xid-kit/types'
import { apiErrorDescriptor } from '@xid-kit/web-ui/api-error-message'
import { classifyApiError } from '@xid-kit/web-ui/api-errors'
import { StepUpCancelled } from './step-up'

function isXidError(error: unknown): error is Pick<XidError, 'code' | 'meta'> {
  return typeof error === 'object' && error !== null && 'code' in error
}

export function useActionError(): (error: unknown, fallback: string) => string | null {
  const { i18n } = useLingui()
  return (error, fallback) => {
    if (error instanceof StepUpCancelled) return null
    if (!isXidError(error)) return fallback
    return i18n._(apiErrorDescriptor(classifyApiError(error, { surface: 'general' })))
  }
}

export function errorCode(error: unknown): string | null {
  return isXidError(error) ? error.code : null
}
