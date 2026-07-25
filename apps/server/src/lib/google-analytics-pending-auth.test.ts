import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearPendingAuthCompletion,
  consumePendingAuthCompletion,
  setPendingAuthCompletion,
} from './google-analytics-pending-auth'

describe('google analytics pending auth', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value)
        },
        removeItem: (key: string) => {
          storage.delete(key)
        },
      },
      configurable: true,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'sessionStorage')
  })

  it('stores and consumes pending auth completion once', () => {
    setPendingAuthCompletion({ method: 'social', intent: 'sign_in' })

    expect(consumePendingAuthCompletion()).toEqual({ method: 'social', intent: 'sign_in' })
    expect(consumePendingAuthCompletion()).toBeNull()
  })

  it('clears pending auth without consuming', () => {
    setPendingAuthCompletion({ method: 'magic_link', intent: 'sign_up' })
    clearPendingAuthCompletion()

    expect(consumePendingAuthCompletion()).toBeNull()
  })
})
