// helpers.ts:createXidClient 工厂。getAuth / requireAuth / xidClient 实现在 server.ts,
// 这里一并 re-export,供 index.ts 单点导出。

import { XidClient } from '@xid-kit/core'
import type { XidClientOptions } from '@xid-kit/core'

export type { GetAuthOptions as LoaderAuthOptions } from './server'
export { getAuth, requireAuth, xidClient } from './server'

// createXidClient: 创建一个 XidClient 实例,供 entry.server.tsx / root loader 使用。
//
// Remix 应用通常在 entry.server.tsx 初始化一次,或在 root loader context 中按需创建。
// 每次请求新建 XidClient 无状态影响(token 不存内存,依赖 cookie)。
//
// 用法(entry.server.tsx):
//   import { createXidClient } from '@xid-kit/remix'
//   const xid = createXidClient({ mode: 'same-origin' })
export function createXidClient(options: XidClientOptions): XidClient {
  return new XidClient(options)
}
