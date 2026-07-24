// helpers.ts: createXidClient 工厂与 Remix loader/action helper 兼容层。
// getAuth / requireAuth 现已移至 server.ts,本文件保留 createXidClient 工厂
// 并 re-export server.ts 的完整实现,供 index.ts 统一导出。

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
//   const xid = createXidClient({ publishableKey: process.env.XID_PUBLISHABLE_KEY! })
export function createXidClient(options: XidClientOptions): XidClient {
  return new XidClient(options)
}
