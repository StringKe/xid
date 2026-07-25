// landing 全宽节奏基底:画布贴边,布局容器零 inline padding,页边距由节内部的
// 边缘列经 edgeStart/edgeEnd 自持。贯穿视口的 1px 水平 hairline 是分节语言,
// 竖向 hairline 划列(12 列心智,不对称跨度 5/7、4/8、3/9)。mono 微标签作区头签名。
// gutter 口径统一 clamp(1.25rem, 3vw, 4.5rem):StyleX 静态值,各文件内联副本需同步改。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

const GUTTER = 'clamp(1.25rem, 3vw, 4.5rem)'

// 节纵向节奏口径(全 landing 唯一来源;StyleX 静态值,各文件内联副本需同步):
// SECTION_PAD = 节顶/底呼吸(Section 非 bleed 注入的 paddingBlock 同源);
// SECTION_FOOT = 节内最后一行文本性内容距节底线的最小空间(SectionHead marginBottom 同源)。
const SECTION_PAD = 'clamp(4rem, 5.5vw, 7.5rem)'
const SECTION_FOOT = 'clamp(2.5rem, 4vw, 4.5rem)'

export const shared = stylex.create({
  // 节内容容器:全宽 + 自持 gutter(Section 默认注入;非贴边内容直接复用)。
  measure: {
    width: '100%',
    paddingInline: GUTTER,
  },
  // 边缘列页边距:贴视口左/右边的列用它持有 gutter,代替容器 padding。
  edgeStart: { paddingInlineStart: GUTTER },
  edgeEnd: { paddingInlineEnd: GUTTER },
  // 节纵向节奏:非 bleed 节由 Section 注入;bleed 节自管时复用同一口径。
  sectionPad: { paddingBlock: SECTION_PAD },
  // bleed 节 head 区(SectionHead 容器)持有的节顶空间,与 sectionPad 上半同口径。
  bleedHead: { paddingTop: SECTION_PAD },
  // bleed 节最后一个贴边 ledger 行:行可贴节底线,行内文本经此口径离底
  // (longhand,property-specificity 下覆盖各节 paddingBlock 的 bottom 分量)。
  sectionFoot: { paddingBottom: SECTION_FOOT },
  // 设计系统 .xid-microlabel:uppercase mono 微标签。
  microlabel: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
})
