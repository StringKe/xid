import { describe, it, expect } from 'vitest'
import { setXidContext, getXidContext, XID_CONTEXT_KEY } from '../context'
import type { XidStores } from '../stores'

function makeStoresMock(): XidStores {
  return {} as XidStores
}

describe('setXidContext / getXidContext', () => {
  it('setXidContext calls setContext with XID_CONTEXT_KEY and stores', () => {
    const stores = makeStoresMock()
    const calls: [symbol, XidStores][] = []
    const setContext = (key: symbol, value: XidStores) => {
      calls.push([key, value])
    }

    setXidContext(setContext, stores)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(XID_CONTEXT_KEY)
    expect(calls[0]?.[1]).toBe(stores)
  })

  it('getXidContext returns stores set by setXidContext', () => {
    const stores = makeStoresMock()

    const contextMap = new Map<symbol, XidStores>()
    const setContext = (key: symbol, value: XidStores) => {
      contextMap.set(key, value)
    }
    const getContext = (key: symbol) => contextMap.get(key)

    setXidContext(setContext, stores)
    const retrieved = getXidContext(getContext)
    expect(retrieved).toBe(stores)
  })

  it('getXidContext throws when context has not been set', () => {
    const getContext = (_key: symbol) => undefined
    expect(() => getXidContext(getContext)).toThrow(/setXidContext/)
  })
})
