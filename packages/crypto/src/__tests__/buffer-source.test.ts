import { describe, it, expect } from 'vitest'

import { toBufferSource } from '../buffer-source'

describe('toBufferSource', () => {
  it('returns same view when backed by ArrayBuffer', () => {
    const buf = new ArrayBuffer(8)
    const view = new Uint8Array(buf)
    view[0] = 42
    const normalized = toBufferSource(view)
    expect(normalized).toBe(view)
    expect(normalized.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('returns same subarray when still backed by ArrayBuffer', () => {
    const parent = new Uint8Array(16)
    parent.fill(9)
    const slice = parent.subarray(2, 6)
    const normalized = toBufferSource(slice)
    expect(normalized).toBe(slice)
    expect([...normalized]).toEqual([9, 9, 9, 9])
  })

  it('copies when backed by SharedArrayBuffer', () => {
    if (typeof SharedArrayBuffer === 'undefined') return
    const sab = new SharedArrayBuffer(8)
    const view = new Uint8Array(sab)
    view.set([1, 2, 3, 4])
    const slice = view.subarray(0, 4)
    const normalized = toBufferSource(slice)
    expect(normalized).not.toBe(slice)
    expect(normalized.buffer).toBeInstanceOf(ArrayBuffer)
    expect([...normalized]).toEqual([1, 2, 3, 4])
  })
})
