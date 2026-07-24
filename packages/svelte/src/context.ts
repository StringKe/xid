// context.ts:Svelte setContext / getContext 包装,以 Symbol 为 key 防命名冲突。
// setXidContext:在根 layout (+layout.svelte) 调用。
// getXidContext:在子组件中调用,未挂载则 throw(开发期快速定位)。
// 不直接 import svelte -- 调用方传入 setContext / getContext 函数引用。
// 这样 stores.ts 和 context.ts 保持纯 TS 可测试;.svelte 文件只做接线。

import type { XidStores } from './stores'

export const XID_CONTEXT_KEY: unique symbol = Symbol('@xid-kit/svelte:context')

// Svelte setContext / getContext 最小类型(peerDep,不直接 import)。
type SetContextFn = (key: symbol, value: XidStores) => void
type GetContextFn = (key: symbol) => XidStores | undefined

// setXidContext:在根 layout 的 <script> 中调用,注入 stores。
// 用法:
//   import { setContext } from 'svelte'
//   import { setXidContext } from '@xid-kit/svelte'
//   setXidContext(setContext, stores)
export function setXidContext(setContext: SetContextFn, stores: XidStores): void {
  setContext(XID_CONTEXT_KEY, stores)
}

// getXidContext:在子组件中取回 stores。
// 未在 XidProvider 子树内调用时抛出,方便开发期定位问题。
// 用法:
//   import { getContext } from 'svelte'
//   import { getXidContext } from '@xid-kit/svelte'
//   const stores = getXidContext(getContext)
export function getXidContext(getContext: GetContextFn): XidStores {
  const stores = getContext(XID_CONTEXT_KEY)
  if (!stores) {
    throw new Error(
      '[@xid-kit/svelte] getXidContext was called outside a component tree that has setXidContext. ' +
        'Call setXidContext(setContext, stores) in your root +layout.svelte.',
    )
  }
  return stores
}
