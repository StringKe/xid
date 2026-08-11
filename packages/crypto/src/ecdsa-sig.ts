// ECDSA 签名 DER(ASN.1) <-> JOSE P1363(r||s)互转;Web Crypto 原生 P1363,此模块仅服务 DER 互操作(X.509 / node:crypto / 部分 IdP)。

const P256_COORD_BYTES = 32

// DER INTEGER:去掉左侧零,最高位为 1 时补 0x00 以免被当成负数。
function toDerInteger(coord: Uint8Array): Uint8Array {
  let start = 0
  while (start < coord.length - 1 && coord[start] === 0) start++
  const trimmed = coord.subarray(start)
  const needsPad = (trimmed[0] ?? 0) & 0x80
  if (needsPad) {
    const out = new Uint8Array(trimmed.length + 1)
    out.set(trimmed, 1)
    return out
  }
  return trimmed.slice()
}

export function p1363ToDer(p1363: Uint8Array): Uint8Array {
  if (p1363.length !== P256_COORD_BYTES * 2) {
    throw new Error(`P1363 ES256 signature must be ${P256_COORD_BYTES * 2} bytes`)
  }
  const r = toDerInteger(p1363.subarray(0, P256_COORD_BYTES))
  const s = toDerInteger(p1363.subarray(P256_COORD_BYTES))
  const body = new Uint8Array(2 + r.length + 2 + s.length)
  let offset = 0
  body[offset++] = 0x02
  body[offset++] = r.length
  body.set(r, offset)
  offset += r.length
  body[offset++] = 0x02
  body[offset++] = s.length
  body.set(s, offset)
  const der = new Uint8Array(2 + body.length)
  der[0] = 0x30
  der[1] = body.length
  der.set(body, 2)
  return der
}

// 不可信 DER 严格校验 tag/短形式长度/P-256 坐标范围,右对齐写入 32 字节。
function readDerInteger(der: Uint8Array, offset: number): { coord: Uint8Array; next: number } {
  if (der[offset] !== 0x02) throw new Error('invalid DER: expected INTEGER')
  const len = der[offset + 1]
  if (len === undefined || len >= 0x80) throw new Error('invalid DER: long-form length')
  let valueStart = offset + 2
  let valueLen = len
  const end = valueStart + len
  if (len === 0 || end > der.length) throw new Error('invalid DER: INTEGER length out of bounds')
  if (der[valueStart] === 0x00) {
    valueStart++
    valueLen--
  }
  if (valueLen < 1 || valueLen > P256_COORD_BYTES) {
    throw new Error('invalid DER: INTEGER value length out of P-256 range')
  }
  const coord = new Uint8Array(P256_COORD_BYTES)
  coord.set(der.subarray(valueStart, valueStart + valueLen), P256_COORD_BYTES - valueLen)
  return { coord, next: end }
}

// SEQUENCE 长度须与实际一致且无尾随字节,否则 throw。
export function derToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('invalid DER: expected SEQUENCE')
  const seqLen = der[1]
  if (seqLen === undefined || seqLen >= 0x80) throw new Error('invalid DER: long-form length')
  if (der.length !== 2 + seqLen) throw new Error('invalid DER: SEQUENCE length mismatch')
  const rPart = readDerInteger(der, 2)
  const sPart = readDerInteger(der, rPart.next)
  if (sPart.next !== der.length) throw new Error('invalid DER: trailing bytes after INTEGERs')
  const out = new Uint8Array(P256_COORD_BYTES * 2)
  out.set(rPart.coord, 0)
  out.set(sPart.coord, P256_COORD_BYTES)
  return out
}
