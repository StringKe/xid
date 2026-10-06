import type { ApiErrorInput } from '@xid-kit/web-ui/api-errors'
import type { XidError } from '@xid-kit/types'

// react-query 抛出的 error 是 unknown;API client 失败一律是 XidError,其余按 server_error 处理。
export function queryErrorInput(error: unknown): ApiErrorInput {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code, meta } = error as Pick<XidError, 'code' | 'meta'>
    return meta ? { code, meta } : { code }
  }
  return { code: 'server_error' }
}
