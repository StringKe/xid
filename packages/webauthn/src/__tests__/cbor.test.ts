import { describe, it, expect } from 'vitest'

import { cborDecode, cborDecodeFirst } from '../cbor'

describe('cbor decode', () => {
  it('decodes unsigned integers', () => {
    expect(cborDecode(new Uint8Array([0x00]))).toBe(0)
    expect(cborDecode(new Uint8Array([0x18, 0x2a]))).toBe(42)
  })

  it('decodes negative integers', () => {
    expect(cborDecode(new Uint8Array([0x20]))).toBe(-1)
    expect(cborDecode(new Uint8Array([0x21]))).toBe(-2)
  })

  it('decodes text and byte strings', () => {
    expect(cborDecode(new Uint8Array([0x63, 0x66, 0x6f, 0x6f]))).toBe('foo')
    const bytes = cborDecode(new Uint8Array([0x42, 0x01, 0x02])) as Uint8Array
    expect([...bytes]).toEqual([1, 2])
  })

  it('decodes arrays and maps', () => {
    const array = cborDecode(new Uint8Array([0x83, 0x01, 0x02, 0x03])) as readonly number[]
    expect([...array]).toEqual([1, 2, 3])

    const map = cborDecode(new Uint8Array([0xa2, 0x01, 0x02, 0x03, 0x04])) as Map<number, number>
    expect(map.get(1)).toBe(2)
    expect(map.get(3)).toBe(4)
  })

  it('rejects trailing bytes and truncated input', () => {
    expect(() => cborDecode(new Uint8Array([0x00, 0x00]))).toThrow(/trailing bytes/)
    expect(() => cborDecode(new Uint8Array([0x18]))).toThrow(/truncated/)
  })

  it('cborDecodeFirst reports bytesUsed for embedded values', () => {
    const payload = new Uint8Array([0xa1, 0x01, 0x02, 0xff])
    const { value, bytesUsed } = cborDecodeFirst(payload)
    expect(value).toBeInstanceOf(Map)
    expect(bytesUsed).toBe(3)
  })
})
