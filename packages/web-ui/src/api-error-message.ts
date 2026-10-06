import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { errorMessages } from '@xid-kit/i18n'
import { classifyApiError } from './api-errors'
import type { ApiErrorClassification, ApiErrorInput, ApiErrorOptions } from './api-errors'

const PASSWORD_LENGTH_MESSAGE = msg`Use a password with 12 to 128 characters.`

export function apiErrorDescriptor(classification: ApiErrorClassification): MessageDescriptor {
  if (classification.code === 'validation_failed' && classification.paramName === 'password') {
    return PASSWORD_LENGTH_MESSAGE
  }
  return errorMessages[classification.code] ?? errorMessages.server_error
}

export function useApiErrorMessage(): (error: ApiErrorInput, options: ApiErrorOptions) => string {
  const { i18n } = useLingui()
  return (error, options) => i18n._(apiErrorDescriptor(classifyApiError(error, options)))
}

// 管理面(非凭证)表单与操作的错误文案;没有错误时返回 undefined,便于直接传给 Field.error。
export function useManagementErrorMessage(): (
  error: ApiErrorInput | null | undefined,
) => string | undefined {
  const format = useApiErrorMessage()
  return (error) => (error ? format(error, { surface: 'general' }) : undefined)
}

// paramName 可能是数组下标路径(redirect_uris.0),按首段归属到表单字段。
export function errorTargetsField(error: ApiErrorInput | null | undefined, field: string): boolean {
  const paramName = error?.meta?.paramName
  return paramName === field || paramName?.startsWith(`${field}.`) === true
}
