import { XidClient } from '@xid-kit/core'
import type { XidClientOptions } from '@xid-kit/core'

export type { GetAuthOptions as LoaderAuthOptions } from './server'
export { getAuth, requireAuth, xidClient } from './server'

// XidClient 无内存 token 状态（依赖 cookie），可按请求新建。
export function createXidClient(options: XidClientOptions): XidClient {
  return new XidClient(options)
}
