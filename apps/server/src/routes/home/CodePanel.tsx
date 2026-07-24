// CodePanel:landing 深色代码面板原语(trace 终端 / 协议步进器 / 集成代码共用)。
// PanelFrame = 深色圆角容器,PanelChrome = 三点 + 文件标签 + 右侧动作槽,
// CodeLines = 类型化 token 手工着色(无第三方 highlighter,bundle/冷启动考量)。
// 代码文本是字面量(标识符/协议语法),不本地化;仅 chrome 的动作文案由调用方本地化。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { LX_RAW } from './landing-palette'
import { lx } from './landing-theme.stylex'

export const TOKEN_KINDS = [
  'plain',
  'keyword',
  'string',
  'fn',
  'comment',
  'punctuation',
  'property',
  'ok',
] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

export type Token = {
  readonly text: string
  readonly kind?: TokenKind
}

// 一行源码是 token 列表;空列表渲染空行。
export type CodeLine = readonly Token[]

// 颜色经 inline style 应用:token kind 是 runtime 索引,StyleX 动态函数在缺省时会产生无效值。
const KIND_COLOR: Record<TokenKind, string> = {
  plain: LX_RAW.onCode,
  keyword: LX_RAW.syntax.keyword,
  string: LX_RAW.syntax.string,
  fn: LX_RAW.syntax.fn,
  comment: LX_RAW.syntax.comment,
  punctuation: LX_RAW.syntax.punctuation,
  property: LX_RAW.syntax.property,
  ok: LX_RAW.syntax.string,
}

const lineIn = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(5px)' },
  to: { opacity: 1, transform: 'none' },
})

export const panel = stylex.create({
  // .lp-trace / .lp-codewrap / .lp-how__panel 共用的深色外框。
  frame: {
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: lx.code,
    // 深色证明物:rim + 短接触影,禁 hairline + 40px 扩散 blur(AI 味)。
    boxShadow: `inset 0 1px 0 color-mix(in oklch, ${lx.onCode} 10%, transparent), 0 10px 24px oklch(0 0 0 / 0.24)`,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: lx.onCodeLine,
    overflow: 'hidden',
  },
  chrome: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    paddingBlock: '0.7rem',
    paddingInline: '0.95rem',
    backgroundColor: lx.codeRaised,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.onCodeLine,
  },
  dot: {
    width: '0.55rem',
    height: '0.55rem',
    borderRadius: '50%',
    backgroundColor: lx.onCodeDim,
    opacity: 0.5,
    flexShrink: 0,
  },
  file: {
    marginLeft: '0.375rem',
    fontFamily: lx.mono,
    fontSize: '0.78rem',
    color: lx.onCodeDim,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  pre: {
    margin: 0,
    paddingBlock: '1.1rem',
    paddingInline: '1.25rem',
    fontFamily: lx.mono,
    fontSize: '0.8125rem',
    lineHeight: 1.95,
    color: lx.onCode,
    overflowX: 'auto',
    tabSize: 2,
  },
  preTall: { minHeight: '15rem' },
  // 覆盖 6 行面板(6 x 1.584rem + 2.2rem padding = 11.71rem),tab 切换高度恒定零 CLS。
  preMid: { minHeight: '11.75rem' },
  line: { display: 'block', whiteSpace: 'pre' },
  lineStagger: {
    animationName: { default: lineIn, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: '0.3s',
    animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    animationFillMode: 'both',
  },
})

type PanelChromeProps = {
  file: string
  // 右侧动作槽(复制按钮等),由调用方提供。
  action?: ReactNode
}

export function PanelChrome({ file, action }: PanelChromeProps): ReactNode {
  return (
    <div {...stylex.props(panel.chrome)}>
      <span aria-hidden {...stylex.props(panel.dot)} />
      <span aria-hidden {...stylex.props(panel.dot)} />
      <span aria-hidden {...stylex.props(panel.dot)} />
      <span {...stylex.props(panel.file)}>{file}</span>
      {action}
    </div>
  )
}

type CodeLinesProps = {
  lines: readonly CodeLine[]
  // true 时逐行错峰入场(集成区代码面板)。
  stagger?: boolean
  height?: 'auto' | 'mid' | 'tall'
}

export function CodeLines({ lines, stagger = false, height = 'auto' }: CodeLinesProps): ReactNode {
  const heightStyle = height === 'tall' ? panel.preTall : height === 'mid' ? panel.preMid : null
  return (
    <pre {...stylex.props(panel.pre, heightStyle)}>
      <code>
        {lines.map((line, lineIndex) => (
          <span
            // 源码行无稳定 id;index 是此处的自然 key。
            // eslint-disable-next-line react/no-array-index-key
            key={lineIndex}
            {...stylex.props(panel.line, stagger && panel.lineStagger)}
            style={stagger ? { animationDelay: `${lineIndex * 36}ms` } : undefined}
          >
            {line.length === 0 ? ' ' : null}
            {line.map((token, tokenIndex) => (
              <span
                // eslint-disable-next-line react/no-array-index-key
                key={tokenIndex}
                style={{ color: KIND_COLOR[token.kind ?? 'plain'] }}
              >
                {token.text}
              </span>
            ))}
          </span>
        ))}
      </code>
    </pre>
  )
}
