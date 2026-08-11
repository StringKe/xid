// 注入 setContext/getContext 引用，避免本文件静态 import svelte，便于纯 TS 测试。

import type { XidStores } from './stores'

export const XID_CONTEXT_KEY: unique symbol = Symbol('@xid-kit/svelte:context')

type SetContextFn = (key: symbol, value: XidStores) => void
type GetContextFn = (key: symbol) => XidStores | undefined

export function setXidContext(setContext: SetContextFn, stores: XidStores): void {
  setContext(XID_CONTEXT_KEY, stores)
}

// 未 setXidContext 时抛错，开发期定位挂载遗漏
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
