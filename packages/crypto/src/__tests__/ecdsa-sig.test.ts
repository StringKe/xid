// ECDSA P1363 <-> DER 转换 round-trip,并与 Web Crypto 原生 P1363 签名互验。
import { describe, it, expect } from 'vitest'

import { p1363ToDer, derToP1363 } from '../ecdsa-sig'

describe('ECDSA signature format conversion (ES256)', () => {
  it('round-trips a real Web Crypto P1363 signature through DER and back', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const data = new TextEncoder().encode('message')
    const p1363 = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data),
    )
    expect(p1363.byteLength).toBe(64)

    const der = p1363ToDer(p1363)
    expect(der[0]).toBe(0x30) // SEQUENCE
    const back = derToP1363(der)
    expect(back).toEqual(p1363)
  })

  it('pads short coordinates with leading zeros and strips DER 0x00 prefix correctly', () => {
    // r 高位为 1(需 DER 补 0x00),s 有前导零(P1363 左补零)。
    const p1363 = new Uint8Array(64)
    p1363[0] = 0x80 // r 最高字节最高位为 1
    p1363[63] = 0x01 // s 仅末字节非零
    const der = p1363ToDer(p1363)
    const back = derToP1363(der)
    expect(back).toEqual(p1363)
  })

  it('rejects a P1363 signature of wrong length', () => {
    expect(() => p1363ToDer(new Uint8Array(32))).toThrow(/64 bytes/)
  })
})

// 畸形 DER 拒绝向量:[名称, 字节, 期望错误片段]。derToP1363 对不可信输入须 throw。
const MALFORMED_DER_VECTORS: ReadonlyArray<readonly [string, Uint8Array, RegExp]> = [
  [
    'non-SEQUENCE first byte',
    new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    /expected SEQUENCE/,
  ],
  [
    'long-form SEQUENCE length',
    new Uint8Array([0x30, 0x81, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    /long-form length/,
  ],
  [
    'SEQUENCE length mismatch',
    new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0xff]),
    /SEQUENCE length mismatch/,
  ],
  [
    'non-INTEGER tag',
    new Uint8Array([0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01]),
    /expected INTEGER/,
  ],
  [
    'long-form INTEGER length',
    new Uint8Array([0x30, 0x07, 0x02, 0x81, 0x01, 0x01, 0x02, 0x01, 0x01]),
    /long-form length/,
  ],
  [
    'INTEGER length out of bounds',
    new Uint8Array([0x30, 0x06, 0x02, 0x20, 0x01, 0x02, 0x01, 0x01]),
    /out of bounds/,
  ],
  [
    'zero-length INTEGER',
    new Uint8Array([0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x01]),
    /out of bounds/,
  ],
  [
    'oversized INTEGER value (>32 bytes)',
    new Uint8Array([0x30, 0x26, 0x02, 0x21, ...new Array<number>(33).fill(0x01), 0x02, 0x01, 0x01]),
    /out of P-256 range/,
  ],
  [
    'trailing bytes after two INTEGERs',
    new Uint8Array([0x30, 0x09, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    /trailing bytes/,
  ],
]

describe('derToP1363: strict validation of untrusted DER', () => {
  it('accepts a minimal well-formed DER (SEQUENCE{INTEGER 1, INTEGER 1})', () => {
    const out = derToP1363(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]))
    expect(out.byteLength).toBe(64)
    expect(out[31]).toBe(0x01)
    expect(out[63]).toBe(0x01)
  })

  it.each(MALFORMED_DER_VECTORS)('rejects %s', (_name, der, pattern) => {
    expect(() => derToP1363(der)).toThrow(pattern)
  })
})

describe('derToP1363: 64-byte DER must convert (not be mistaken for P1363)', () => {
  it('converts a well-formed 64-byte DER (two 29-byte INTEGERs) to right-aligned P1363', () => {
    // 30 3e 02 1d <29B r> 02 1d <29B s> = 64 字节;r/s 首字节 < 0x80 不需 0x00 pad,长度 29 在 P-256 范围内。
    const r = new Uint8Array(29).fill(0x42)
    const s = new Uint8Array(29).fill(0x37)
    const der = new Uint8Array([0x30, 0x3e, 0x02, 0x1d, ...r, 0x02, 0x1d, ...s])
    expect(der.byteLength).toBe(64) // 长度恰好 64,若按长度启发式会被误当 P1363

    const p1363 = derToP1363(der)
    expect(p1363.byteLength).toBe(64)
    // r 右对齐到前 32 字节:首 3 字节为 0x00 padding,其后 29 字节为 r。
    expect(p1363[2]).toBe(0x00)
    expect(p1363[3]).toBe(0x42)
    expect(p1363[31]).toBe(0x42)
    // s 右对齐到后 32 字节。
    expect(p1363[34]).toBe(0x00)
    expect(p1363[35]).toBe(0x37)
    expect(p1363[63]).toBe(0x37)
  })

  it('round-trips that 64-byte DER through p1363ToDer back to identical bytes', () => {
    const r = new Uint8Array(29).fill(0x42)
    const s = new Uint8Array(29).fill(0x37)
    const der = new Uint8Array([0x30, 0x3e, 0x02, 0x1d, ...r, 0x02, 0x1d, ...s])
    expect(p1363ToDer(derToP1363(der))).toEqual(der)
  })
})
