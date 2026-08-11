// TS 5.7 起 Uint8Array 可能由 SharedArrayBuffer 支撑,而 workers-types 的 SubtleCrypto 要求 ArrayBuffer 视图;此处归一化以保证类型与运行时兼容。

export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>
  }
  return new Uint8Array(bytes)
}
