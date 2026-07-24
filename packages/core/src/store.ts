// 框架无关响应式 store:XidClient 内部状态的单一真相源 + 监听分发。
// @xid-kit/react 的 useAuth/useUser/useOrganization/useSession 通过 subscribe + getSnapshot
// 绑定到 React useSyncExternalStore;core 不依赖任何框架。

import type { XidState, XidStateListener, Unsubscribe } from './types'

const INITIAL_STATE: XidState = {
  status: 'loading',
  isLoaded: false,
  isSignedIn: false,
  session: null,
  user: null,
  organization: null,
  sessions: [],
  error: null,
}

export class XidStore {
  #state: XidState = INITIAL_STATE
  readonly #listeners = new Set<XidStateListener>()

  // 稳定引用,供 useSyncExternalStore.getSnapshot 直接返回(同值不触发 re-render)。
  getSnapshot = (): XidState => this.#state

  subscribe(listener: XidStateListener): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // 局部更新:仅当有字段真正变化时替换引用并通知,避免无效广播。
  setState(patch: Partial<XidState>): void {
    const next = { ...this.#state, ...patch }
    if (shallowEqual(this.#state, next)) return
    this.#state = next
    this.#emit()
  }

  reset(): void {
    this.setState({ ...INITIAL_STATE })
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state)
  }
}

function shallowEqual(a: XidState, b: XidState): boolean {
  const keys = Object.keys(a) as (keyof XidState)[]
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}
