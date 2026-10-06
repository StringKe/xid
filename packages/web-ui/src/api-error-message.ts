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
