// platform console 模块通用数据拉取 hook。

import { useCallback, useEffect, useState } from 'react'
import type { XidError } from '@xid-kit/types'
import { useAuth } from '../../lib/auth-context'

export type ApiGetState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: XidError }
  | { status: 'ok'; data: T }

export function useApiGet<T>(path: string, skip = false): ApiGetState<T> & { reload: () => void } {
  const { api } = useAuth()
  const [state, setState] = useState<ApiGetState<T>>({ status: 'loading' })
  const [rev, setRev] = useState(0)

  useEffect(() => {
    if (skip) return
    setState({ status: 'loading' })
    const ctrl = new AbortController()
    void api.get<T>(path, { signal: ctrl.signal }).then((result) => {
      if (result.ok) setState({ status: 'ok', data: result.value })
      else setState({ status: 'error', error: result.error })
    })
    return () => ctrl.abort()
  }, [api, path, skip, rev])

  const reload = useCallback(() => setRev((v) => v + 1), [])
  return Object.assign(state, { reload })
}
