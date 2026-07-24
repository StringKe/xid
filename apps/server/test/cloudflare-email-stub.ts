// 测试桩:node 测试池无法解析 workerd 内置模块 cloudflare:email。
// 仅为 import 解析提供最小 EmailMessage 实现;不在测试中实际发信(provider.send 被 mock 或不触发)。
// 经 vitest.config.ts resolve.alias 注入。

export class EmailMessage {
  readonly from: string
  readonly to: string
  readonly raw: string

  constructor(from: string, to: string, raw: string) {
    this.from = from
    this.to = to
    this.raw = raw
  }
}
