// TPM 2.0 结构解码(TPM 2.0 Library Part 2):attestation 用到的 TPMT_PUBLIC 与 TPMS_ATTEST。
// 只做字节布局解析,不涉及任何密码运算。所有整数为大端。

const TPM_ALG_NULL = 0x0010
export const TPM_ALG_RSA = 0x0001
export const TPM_ALG_ECC = 0x0023

class Reader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  u16(): number {
    const b = this.take(2)
    return (b[0]! << 8) | b[1]!
  }

  u32(): number {
    const b = this.take(4)
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  }

  sized(): Uint8Array {
    return this.take(this.u16())
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new Error('tpm: truncated structure')
    const out = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) throw new Error('tpm: trailing bytes')
  }
}

export type TpmPublic =
  | { type: typeof TPM_ALG_RSA; nameAlg: number; modulus: Uint8Array; exponent: number }
  | { type: typeof TPM_ALG_ECC; nameAlg: number; curveId: number; x: Uint8Array; y: Uint8Array }

// symmetric / scheme / kdf 在算法不是 TPM_ALG_NULL 时后面跟附加字段。
function skipSymmetric(reader: Reader): void {
  if (reader.u16() !== TPM_ALG_NULL) reader.take(4)
}

function skipScheme(reader: Reader): void {
  if (reader.u16() !== TPM_ALG_NULL) reader.take(2)
}

export function parseTpmPublic(bytes: Uint8Array): TpmPublic {
  const reader = new Reader(bytes)
  const type = reader.u16()
  const nameAlg = reader.u16()
  reader.u32()
  reader.sized()
  if (type === TPM_ALG_RSA) {
    skipSymmetric(reader)
    skipScheme(reader)
    reader.u16()
    const exponent = reader.u32()
    const modulus = reader.sized()
    reader.assertDone()
    return { type, nameAlg, modulus, exponent: exponent === 0 ? 65537 : exponent }
  }
  if (type === TPM_ALG_ECC) {
    skipSymmetric(reader)
    skipScheme(reader)
    const curveId = reader.u16()
    skipScheme(reader)
    const x = reader.sized()
    const y = reader.sized()
    reader.assertDone()
    return { type, nameAlg, curveId, x, y }
  }
  throw new Error('tpm: unsupported public area type')
}

export type TpmAttest = {
  magic: number
  type: number
  extraData: Uint8Array
  attestedName: Uint8Array
}

export function parseTpmAttest(bytes: Uint8Array): TpmAttest {
  const reader = new Reader(bytes)
  const magic = reader.u32()
  const type = reader.u16()
  reader.sized()
  const extraData = reader.sized()
  reader.take(17)
  reader.take(8)
  const attestedName = reader.sized()
  reader.sized()
  reader.assertDone()
  return { magic, type, extraData, attestedName }
}

// nameAlg 的 TPM 算法 id 到 Web Crypto 摘要名。
export const TPM_HASH_ALGS: Readonly<Record<number, string>> = {
  0x0004: 'SHA-1',
  0x000b: 'SHA-256',
  0x000c: 'SHA-384',
  0x000d: 'SHA-512',
}

export const TPM_ECC_CURVES: Readonly<Record<number, string>> = {
  0x0003: 'P-256',
  0x0004: 'P-384',
  0x0005: 'P-521',
}
