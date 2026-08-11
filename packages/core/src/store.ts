// 框架无关状态源;箭头 getSnapshot 保持稳定引用,供 useSyncExternalStore 跳过无变化 re-render。

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

  getSnapshot = (): XidState => this.#state

  subscribe(listener: XidStateListener): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // 字段无实质变化时不换引用,避免无效广播。
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
