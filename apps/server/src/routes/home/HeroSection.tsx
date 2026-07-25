// HeroSection:全宽贴边 hero。12 列心智的 7/5 不对称分栏,一条竖向 hairline 从页头
// 底线贯到 stats 顶线把两栏切成账本列:左栏文案(eyebrow + display 标题 + 副文 +
// 双 CTA + mono 规格条),右栏下沉"仪表舱"(trace 终端 + 边缘节点带)。
// 下方 stats ledger 横贯整个视口:四格被竖线划开,首尾格自持页边距。
// 密度即视觉:无渐变无插画,证明物(终端/节点带/数据)承担视觉权重。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { space } from './landing-space.stylex'
import { CtaLink } from './landing-cta'
import { EdgeStrip } from './EdgeStrip'
import { TraceTerminal } from './TraceTerminal'
import { useEdgeProbeData } from './EdgeProbeProvider'
import { formatRoundTrips, formatTokenWindow, formatVerifyMicros } from './edge-probe-format'

// 与 landing-styles 的 gutter 口径一致(StyleX 静态值,内联副本)。
const GUTTER = 'clamp(1.25rem, 3vw, 4.5rem)'
const CELL_PAD = 'clamp(1.25rem, 2.5vw, 3.5rem)'

const styles = stylex.create({
  section: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.hairline,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 7fr) minmax(0, 5fr)',
      '@media (max-width: 64rem)': 'minmax(0, 1fr)',
    },
    alignItems: 'stretch',
  },
  copy: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    paddingBlock: 'clamp(3.5rem, 6vw, 7.5rem)',
    paddingInlineEnd: {
      default: 'clamp(2.5rem, 5vw, 7rem)',
      '@media (max-width: 64rem)': GUTTER,
    },
  },
  eyebrow: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: space.base,
    color: lx.ink,
    margin: '0 0 1.5rem',
  },
  heading: {
    fontSize: 'clamp(2.625rem, 1.2rem + 3vw, 5rem)',
    lineHeight: 1.04,
    // display 字距下限红线 >= -0.04em,更紧会让大字号字符贴住。
    letterSpacing: '-0.04em',
    fontWeight: 650,
    margin: 0,
    // balance:多行时均匀折行,中文标题不再"单字悬行尾"。
    textWrap: 'balance',
    color: lx.primary,
  },
  em: { fontStyle: 'normal', color: lx.ink },
  sub: {
    fontSize: 'clamp(1.0625rem, 1rem + 0.3vw, 1.3125rem)',
    lineHeight: 1.6,
    color: lx.secondary,
    margin: '1.5rem 0 0',
    textWrap: 'pretty',
  },
  ctaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.875rem',
    marginTop: '2rem',
  },
  arrow: { fontFamily: lx.mono },
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${space.snug} ${space.loose}`,
    marginTop: 'clamp(3rem, 5vw, 4.5rem)',
    marginBottom: 0,
    marginInlineStart: 0,
    // 负 margin 抵消 copy 列的 paddingInlineEnd:顶线一直贯到中央竖线,不在列内悬停。
    marginInlineEnd: {
      default: 'calc(-1 * clamp(2.5rem, 5vw, 7rem))',
      '@media (max-width: 64rem)': 0,
    },
    padding: '1.25rem 0 0',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
    listStyle: 'none',
  },
  stripItem: {
    fontFamily: lx.mono,
    fontSize: '0.8125rem',
    color: lx.secondary,
    display: 'flex',
    alignItems: 'center',
    gap: space.snug,
  },
  stripSlash: { color: lx.ink },
  // 仪表舱:下沉底 + 左竖线(贴边到视口右缘);窄屏改为上边线堆叠。
  proof: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minWidth: 0,
    backgroundColor: lx.sunken,
    borderLeftWidth: '1px',
    borderLeftStyle: { default: 'solid', '@media (max-width: 64rem)': 'none' },
    borderLeftColor: lx.hairline,
    borderTopWidth: '1px',
    borderTopStyle: { default: 'none', '@media (max-width: 64rem)': 'solid' },
    borderTopColor: lx.hairline,
    paddingBlock: 'clamp(2.5rem, 4vw, 5rem)',
    paddingInlineStart: {
      default: 'clamp(2rem, 3.5vw, 5rem)',
      '@media (max-width: 64rem)': GUTTER,
    },
  },
  // 终端贴列起点(不在舱内二次居中),46rem 是组件呈现宽度上限,非文本行长。
  proofStack: {
    width: '100%',
    maxWidth: '46rem',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: space.roomy,
  },
  // stats ledger:贴边横贯全宽,四格竖线划开,首尾格经 edgeStart/edgeEnd 自持页边距。
  stats: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(4, minmax(0, 1fr))',
      '@media (max-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
    },
    margin: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  statCell: {
    paddingBlock: 'clamp(1.75rem, 2.5vw, 3rem)',
    paddingInlineStart: CELL_PAD,
    paddingInlineEnd: CELL_PAD,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: lx.hairline,
  },
  statFirst: { borderLeftStyle: 'none' },
  // <=48rem 折成两列时,第 2 格成为首行右缘格,右内距对齐页边距口径。
  statSecond: {
    paddingInlineEnd: { default: CELL_PAD, '@media (max-width: 48rem)': GUTTER },
  },
  // <=48rem 折成两列时,第 3/4 格换行:第 3 格去左线持页边距,两格补上边线。
  statThird: {
    borderLeftStyle: { default: 'solid', '@media (max-width: 48rem)': 'none' },
    paddingInlineStart: { default: CELL_PAD, '@media (max-width: 48rem)': GUTTER },
    borderTopWidth: '1px',
    borderTopStyle: { default: 'none', '@media (max-width: 48rem)': 'solid' },
    borderTopColor: lx.hairline,
  },
  statFourth: {
    borderTopWidth: '1px',
    borderTopStyle: { default: 'none', '@media (max-width: 48rem)': 'solid' },
    borderTopColor: lx.hairline,
  },
  statLabel: {
    margin: '0 0 0.625rem',
    textWrap: 'balance',
  },
  statValue: {
    // 全宽格子配大数值:ledger 的存在感靠数字尺度,不靠装饰。
    fontSize: 'clamp(2rem, 1rem + 1.8vw, 3.5rem)',
    fontWeight: 600,
    letterSpacing: '-0.03em',
    lineHeight: 1.05,
    minHeight: '1.05em',
    margin: 0,
    fontVariantNumeric: 'tabular-nums',
    color: lx.primary,
  },
  statValuePending: {
    color: lx.secondary,
    opacity: 0.5,
    fontWeight: 500,
  },
})

function HeroCopy(): ReactNode {
  return (
    <>
      <span {...stylex.props(shared.microlabel, styles.eyebrow)}>
        <span aria-hidden {...stylex.props(styles.stripSlash)}>
          {'/'}
        </span>
        <Trans>Edge-native OIDC / OAuth identity provider</Trans>
      </span>
      <h1 {...stylex.props(styles.heading)}>
        <Trans>
          One edge Worker. <em {...stylex.props(styles.em)}>The whole identity stack.</em>
        </Trans>
      </h1>
      <p {...stylex.props(styles.sub)}>
        <Trans>
          OIDC / OAuth with mandatory PKCE S256, organization RBAC, enterprise SSO, SCIM 2.0, and
          passkey-first sign-in. 15 TypeScript and 13 native SDKs ship the same protocol to web,
          mobile, desktop, and server. Wire it once; every token verifies at the edge with no
          network round trip.
        </Trans>
      </p>
      <div {...stylex.props(styles.ctaRow)}>
        <CtaLink
          href="/sign-up"
          variant="primary"
          size="lg"
          analyticsId="hero_start_integrating"
          analyticsPlacement="hero"
        >
          <Trans>Start integrating</Trans>
          <span aria-hidden {...stylex.props(styles.arrow)}>
            {'->'}
          </span>
        </CtaLink>
        <CtaLink
          href="/docs"
          variant="secondary"
          size="lg"
          analyticsId="hero_read_docs"
          analyticsPlacement="hero"
        >
          <Trans>Read the protocol docs</Trans>
        </CtaLink>
      </div>
      <HeroStrip />
    </>
  )
}

function HeroStrip(): ReactNode {
  const items = [
    { id: 'idp', label: <Trans>OIDC · OAuth IdP</Trans> },
    { id: 'rbac', label: <Trans>Organization RBAC</Trans> },
    { id: 'sso', label: <Trans>Enterprise SSO + SCIM</Trans> },
    { id: 'passkeys', label: <Trans>Passkeys</Trans> },
    { id: 'sdks', label: <Trans>15 TS + 13 native SDKs</Trans> },
    { id: 'languages', label: <Trans>UI in 8 languages</Trans> },
  ]
  return (
    <ul {...stylex.props(styles.strip)}>
      {items.map((item) => (
        <li key={item.id} {...stylex.props(styles.stripItem)}>
          <span aria-hidden {...stylex.props(styles.stripSlash)}>
            {'/'}
          </span>
          {item.label}
        </li>
      ))}
    </ul>
  )
}

function HeroStats(): ReactNode {
  const { t } = useLingui()
  const probe = useEdgeProbeData()
  const pending = probe === null
  const stats = [
    {
      value: probe ? formatVerifyMicros(probe.verifyUs) : '···',
      label: t`verify · this Worker`,
    },
    {
      value: probe ? formatRoundTrips(probe.jwksRoundTrips) : '···',
      label: t`network round trips`,
    },
    {
      value: probe ? formatTokenWindow(probe.accessTokenTtlSec) : '···',
      label: t`access-token window`,
    },
    {
      value: probe?.signingAlg ?? '···',
      label: t`asymmetric signing`,
    },
  ]
  return (
    <dl {...stylex.props(styles.stats)} aria-busy={pending}>
      {stats.map((stat, index) => (
        <div
          key={stat.label}
          {...stylex.props(
            styles.statCell,
            // stats 是 hero 节内最后贴边行:文本经 sectionFoot 离节底线。
            shared.sectionFoot,
            index === 0 && styles.statFirst,
            index === 0 && shared.edgeStart,
            index === 1 && styles.statSecond,
            index === 2 && styles.statThird,
            index === 3 && styles.statFourth,
            index === 3 && shared.edgeEnd,
          )}
        >
          <dt {...stylex.props(shared.microlabel, styles.statLabel)}>{stat.label}</dt>
          <dd {...stylex.props(styles.statValue, pending && styles.statValuePending)}>
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function HeroSection(): ReactNode {
  return (
    <section id="top" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.grid)}>
        <div {...stylex.props(shared.edgeStart, styles.copy)}>
          <HeroCopy />
        </div>
        <div {...stylex.props(shared.edgeEnd, styles.proof)}>
          <div {...stylex.props(styles.proofStack)}>
            <TraceTerminal />
            <EdgeStrip />
          </div>
        </div>
      </div>
      <HeroStats />
    </section>
  )
}
