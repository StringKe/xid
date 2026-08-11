// WebAuthn 所需的 CBOR 子集解码（无 indefinite-length）；格式损坏 throw，非密码学路径。

export type CborValue = number | bigint | string | Uint8Array | readonly CborValue[] | CborMap

// COSE 用整数 label、attestationObject 用文本 key，Map 同时保序与混合 key 类型。
export type CborMap = Map<number | bigint | string, CborValue>

type Decoded = {
  value: CborValue
  next: number
}

const MAJOR_UINT = 0
const MAJOR_NINT = 1
const MAJOR_BYTES = 2
const MAJOR_TEXT = 3
const MAJOR_ARRAY = 4
const MAJOR_MAP = 5

function cborError(reason: string): Error {
  return new Error(`cbor decode failed: ${reason}`)
}

function readLength(bytes: Uint8Array, offset: number): { length: number; next: number } {
  const info = bytes[offset]! & 0x1f
  if (info < 24) return { length: info, next: offset + 1 }
  if (info === 24) {
    const v = bytes[offset + 1]
    if (v === undefined) throw cborError('truncated uint8 length')
    return { length: v, next: offset + 2 }
  }
  if (info === 25) {
    if (offset + 2 >= bytes.length) throw cborError('truncated uint16 length')
    return { length: (bytes[offset + 1]! << 8) | bytes[offset + 2]!, next: offset + 3 }
  }
  if (info === 26) {
    if (offset + 4 >= bytes.length) throw cborError('truncated uint32 length')
    const v =
      bytes[offset + 1]! * 0x1000000 +
      (bytes[offset + 2]! << 16) +
      (bytes[offset + 3]! << 8) +
      bytes[offset + 4]!
    return { length: v, next: offset + 5 }
  }
  throw cborError('unsupported length encoding (indefinite or 64-bit)')
}

function decodeItem(bytes: Uint8Array, offset: number): Decoded {
  if (offset >= bytes.length) throw cborError('unexpected end of input')
  const major = bytes[offset]! >> 5

  if (major === MAJOR_UINT) {
    const { length, next } = readLength(bytes, offset)
    return { value: length, next }
  }
  if (major === MAJOR_NINT) {
    const { length, next } = readLength(bytes, offset)
    return { value: -1 - length, next }
  }
  if (major === MAJOR_BYTES) {
    const { length, next } = readLength(bytes, offset)
    if (next + length > bytes.length) throw cborError('truncated byte string')
    return { value: bytes.slice(next, next + length), next: next + length }
  }
  if (major === MAJOR_TEXT) {
    const { length, next } = readLength(bytes, offset)
    if (next + length > bytes.length) throw cborError('truncated text string')
    return {
      value: new TextDecoder().decode(bytes.subarray(next, next + length)),
      next: next + length,
    }
  }
  if (major === MAJOR_ARRAY) {
    const { length, next } = readLength(bytes, offset)
    const items: CborValue[] = []
    let pos = next
    for (let i = 0; i < length; i++) {
      const item = decodeItem(bytes, pos)
      items.push(item.value)
      pos = item.next
    }
    return { value: items, next: pos }
  }
  if (major === MAJOR_MAP) {
    const { length, next } = readLength(bytes, offset)
    const map: CborMap = new Map()
    let pos = next
    for (let i = 0; i < length; i++) {
      const key = decodeItem(bytes, pos)
      const val = decodeItem(bytes, key.next)
      if (
        typeof key.value !== 'number' &&
        typeof key.value !== 'string' &&
        typeof key.value !== 'bigint'
      ) {
        throw cborError('unsupported map key type')
      }
      map.set(key.value, val.value)
      pos = val.next
    }
    return { value: map, next: pos }
  }
  throw cborError(`unsupported major type ${major}`)
}

// 返回消费字节数，供 authData 内 COSE_Key 按 CBOR 实际长度切分。
export function cborDecodeFirst(bytes: Uint8Array): { value: CborValue; bytesUsed: number } {
  const { value, next } = decodeItem(bytes, 0)
  return { value, bytesUsed: next }
}

// 要求输入恰好一个顶层值，禁止尾随字节。
export function cborDecode(bytes: Uint8Array): CborValue {
  const { value, next } = decodeItem(bytes, 0)
  if (next !== bytes.length) throw cborError('trailing bytes after top-level value')
  return value
}
