// SDK 文档条目类型与构造辅助。各包页面文件(core.tsx / backend.tsx / ...)用
// defineSdkDoc 构造条目,组文件(ts-frameworks / native-server / native-client)聚合,
// index.ts barrel 输出 SDK_DETAIL_DOCS 给 routes/docs/index.tsx 消费。
// 状态措辞红线(docs/sdks/platform-matrix.md):
//   TS 包(packages/*)     = "Current package"
//   原生 SDK(sdk/*)        = "Implemented · verified locally"(正文注明 real IdP round-trip 待人工验证)
//   禁止 production-ready / stable / Scaffold 措辞。

import type { ReactNode } from 'react'

export type SdkDocSection = {
  heading: ReactNode
  body?: readonly ReactNode[]
  bullets?: readonly ReactNode[]
  code?: string
  table?: {
    headers: readonly ReactNode[]
    rows: readonly (readonly ReactNode[])[]
  }
}

export type SdkDocEntry = {
  slug: string
  // 包标识(如 "@xid-kit/core"、"sdk/go")是代码字面量,不进 lingui,直接作页面标题渲染。
  title: ReactNode
  // 同 title 的纯字符串形态,供 dev 路由诊断 JSON 输出(Trans 节点无法序列化)。
  titleLabel: string
  href: string
  summary: ReactNode
  sections: readonly SdkDocSection[]
}

export type SdkDocInput = {
  // 公开 docs slug,固定 "sdks/<name>" 形态,需同步注册到 apps/server/public-docs.ts。
  slug: string
  // 规范包标识:TS 包用 npm 名(@xid-kit/<name>),原生 SDK 用目录名(sdk/<lang>)。
  packageName: string
  summary: ReactNode
  sections: readonly SdkDocSection[]
}

export function defineSdkDoc(input: SdkDocInput): SdkDocEntry {
  return {
    slug: input.slug,
    title: input.packageName,
    titleLabel: input.packageName,
    href: `/docs/${input.slug}`,
    summary: input.summary,
    sections: input.sections,
  }
}
