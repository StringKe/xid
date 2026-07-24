// ECDSA 签名格式转换:DER(ASN.1 SEQUENCE)<-> P1363(JOSE 定长 r||s)。
// 自研格式编解码,非安全敏感(见 crypto-boundary rule 第三类)。Web Crypto ECDSA 原生用 P1363,
// 这里供与 DER 格式签名(如 X.509 / node:crypto / 部分上游 IdP)互操作时转换。

const P256_COORD_BYTES = 32

// 去掉左侧零填充,但至少保留 1 字节;若最高位为 1,DER INTEGER 需补 0x00 前缀。
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

// P1363(r||s,各 32 字节)-> DER。仅支持 P-256(ES256)。
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

// 严格解析一个 DER INTEGER,右对齐写入 32 字节坐标(去单个前导 0x00,左侧补零)。
// 对不可信输入做全量结构校验:tag、短形式长度、剥 0x00 后 valueLen 1..32、不越界。
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

// DER -> P1363(r||s,各 32 字节)。仅支持 P-256(ES256)。对不可信 DER 做严格结构校验,
// 任一不满足 throw:SEQUENCE tag、短形式长度且 length 字段与实际一致、两 INTEGER 解析后无尾随字节。
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
