// Web Crypto BufferSource 归一化(TS 5.7 + @cloudflare/workers-types 兼容)。
// TS 5.7 起 Uint8Array 带 ArrayBufferLike 泛型,可能被 SharedArrayBuffer 支撑;
// workers-types 的 SubtleCrypto 入参要求 BufferSource(ArrayBufferView<ArrayBuffer>),二者签名冲突。
// 本模块把任意 Uint8Array 归一化为以 ArrayBuffer 支撑的视图,确保运行时与类型双安全。
// 仅做视图/拷贝,不碰任何密码学原语(见 crypto-boundary rule 第三类:格式归一)。

// 归一化为 ArrayBuffer 支撑的 Uint8Array;已是 ArrayBuffer 支撑则原样返回,否则拷贝一份。
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>
  }
  return new Uint8Array(bytes)
}
