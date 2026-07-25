// SectionShell:landing 全宽分节语言。Section = 贴边带,贯穿视口的 1px hairline
// 下边界即分节符;默认注入纵向节奏 + gutter 容器,bleed 模式交出全部编排权
// (节自管贴边 ledger 行)。SectionHead = 不对称分节登记行:左 4 列 mono 微标签
// 分节符(slash 签名),右 8 列标题 + lede,整体滚动入场。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { Reveal } from './Reveal'

const styles = stylex.create({
  section: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.hairline,
  },
  sunken: { backgroundColor: tokens['--xid-sidebar'] },
  head: {
    display: 'grid',
    // 索引列定宽窄列:microlabel 居左缘,标题从稳定近左位置起,不随视口漂移到页面中段。
    gridTemplateColumns: {
      default: 'clamp(9rem, 13vw, 17rem) minmax(0, 1fr)',
      '@media (max-width: 64rem)': 'minmax(0, 1fr)',
    },
    columnGap: 'clamp(2rem, 3vw, 4rem)',
    rowGap: '1rem',
    alignItems: 'start',
    marginBottom: 'clamp(2.5rem, 4vw, 4.5rem)',
  },
  kicker: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '0.625rem',
    color: lx.ink,
    // 视觉对齐右栏 h2 的大写字高(窄屏堆叠时归零)。
    paddingTop: { default: '0.625rem', '@media (max-width: 64rem)': 0 },
  },
  heading: {
    fontSize: 'clamp(1.875rem, 0.95rem + 1.7vw, 3.25rem)',
    lineHeight: 1.08,
    letterSpacing: '-0.032em',
    fontWeight: 640,
    margin: 0,
    textWrap: 'balance',
    color: lx.primary,
  },
  sub: {
    fontSize: 'clamp(1rem, 0.95rem + 0.25vw, 1.1875rem)',
    lineHeight: 1.6,
    color: lx.secondary,
    marginTop: '1rem',
    marginBottom: 0,
    textWrap: 'pretty',
  },
})

type SectionProps = {
  id: string
  tone?: 'page' | 'sunken'
  // true 时不注入 gutter 容器与纵向 padding,节自管贴边编排(全宽 ledger 行)。
  bleed?: boolean
  children: ReactNode
}

export function Section({ id, tone = 'page', bleed = false, children }: SectionProps): ReactNode {
  return (
    <section
      id={id}
      {...stylex.props(
        styles.section,
        tone === 'sunken' && styles.sunken,
        !bleed && shared.sectionPad,
      )}
    >
      {bleed ? children : <div {...stylex.props(shared.measure)}>{children}</div>}
    </section>
  )
}

type SectionHeadProps = {
  kicker: ReactNode
  heading: ReactNode
  sub: ReactNode
}

export function SectionHead({ kicker, heading, sub }: SectionHeadProps): ReactNode {
  return (
    <Reveal sx={styles.head}>
      <span {...stylex.props(shared.microlabel, styles.kicker)}>
        <span aria-hidden>{'/'}</span>
        {kicker}
      </span>
      <div>
        <h2 {...stylex.props(styles.heading)}>{heading}</h2>
        <p {...stylex.props(styles.sub)}>{sub}</p>
      </div>
    </Reveal>
  )
}
