// 账户安全页的写操作错误:需要重新验证时带回当前页跳到 /mfa,其余按错误码渲染本地化文案。

import { useLingui } from '@lingui/react/macro'
import type { XidError } from '@xid-kit/types'
import { apiErrorDescriptor } from '@xid-kit/web-ui/api-error-message'
import { classifyApiError } from '@xid-kit/web-ui/api-errors'
import { useNavigate } from '../../lib/router'

function isXidError(error: unknown): error is Pick<XidError, 'code' | 'meta'> {
  return typeof error === 'object' && error !== null && 'code' in error
}

export function stepUpPath(returnTo: string): string {
  const params = new URLSearchParams({ step_up: '1', redirect_to: returnTo })
  return `/mfa?${params.toString()}`
}

// 返回 null 表示已跳转去重新验证,调用方不再展示错误。
export function useSecurityActionError(): (error: unknown, fallback: string) => string | null {
  const { i18n } = useLingui()
  const navigate = useNavigate()
  return (error, fallback) => {
    if (!isXidError(error)) return fallback
    if (error.code === 'step_up_required') {
      const { pathname, search } = globalThis.location
      navigate(stepUpPath(`${pathname}${search}`))
      return null
    }
    return i18n._(apiErrorDescriptor(classifyApiError(error, { surface: 'general' })))
  }
}
