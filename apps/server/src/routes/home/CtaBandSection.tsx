// CtaBandSection:深色带全宽冲击力编排。
// 全宽 bleed 节,深色 code 底贯穿视口两侧。内容区 4/8 不对称:
// 左 4 列竖排 mono 规格账本(协议签名),右 8 列主 heading + CTA 行。
// 竖向 hairline 切列。两 CTA 并列:primary + ghost 源码链接。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { space } from './landing-space.stylex'
import { CtaLink } from './landing-cta'
import { Reveal } from './Reveal'
import { useEdgeProbeData } from './EdgeProbeProvider'

const SOURCE_URL = 'https://github.com/StringKe/xid'

const styles = stylex.create({
  // 带底不自带边线:下方 SiteFooter 的 borderTop 即分隔,双线(间距 0)删一条。
  band: {
    backgroundColor: lx.code,
  },
  inner: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 4fr) minmax(0, 8fr)',
      '@media (max-width: 56rem)': 'minmax(0, 1fr)',
    },
    alignItems: 'stretch',
    paddingBlock: 'clamp(3.5rem, 6vw, 6rem)',
  },
  // 左侧规格账本列:mono 标签竖排
  specCol: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    paddingInlineEnd: 'clamp(1.5rem, 3vw, 4rem)',
    borderRightWidth: '1px',
    borderRightStyle: { default: 'solid', '@media (max-width: 56rem)': 'none' },
    borderRightColor: lx.onCodeLine,
    paddingBottom: { default: '0', '@media (max-width: 56rem)': '2rem' },
  },
  // microlabel 口径(shared.microlabel)+ 深色带上的 onCodeDim 覆色。
  // 下距走 hairline 邻接口径:与 specList 首行顶线距离 >= 1.25rem。
  specHead: {
    color: lx.onCodeDim,
    margin: '0 0 1.25rem',
  },
  specList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
  },
  specItem: {
    fontFamily: lx.mono,
    fontSize: '0.8125rem',
    letterSpacing: '0.04em',
    color: lx.onCodeDim,
    // hairline 邻接口径:账本行文本与行分隔线距离 >= 1.25rem。
    paddingBlock: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.onCodeLine,
    display: 'flex',
    alignItems: 'center',
    gap: space.snug,
  },
  specSlash: {
    color: lx.ink,
    fontStyle: 'normal',
  },
  // 右侧主内容列
  copy: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    paddingInlineStart: { default: 'clamp(1.5rem, 3vw, 4rem)', '@media (max-width: 56rem)': '0' },
  },
  heading: {
    fontSize: 'clamp(2rem, 3.8vw, 4rem)',
    lineHeight: 1.04,
    letterSpacing: '-0.038em',
    fontWeight: 640,
    color: lx.onCode,
    margin: 0,
    textWrap: 'balance',
    maxWidth: '22ch',
  },
  sub: {
    fontSize: 'clamp(1rem, 0.9rem + 0.3vw, 1.1875rem)',
    lineHeight: 1.6,
    color: lx.onCodeDim,
    margin: '1.25rem 0 0',
    maxWidth: '54ch',
    textWrap: 'pretty',
  },
  ctaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '1rem',
    marginTop: '2.25rem',
  },
  ghost: {
    fontSize: '1rem',
    fontWeight: 500,
    color: lx.onCode,
    fontFamily: lx.mono,
    letterSpacing: '0.01em',
    textDecorationLine: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '3px',
  },
})

const SPEC_ITEMS = [
  { id: 'pkce', label: 'PKCE S256' },
  { id: 'dpop', label: 'DPoP' },
  { id: 'device', label: 'RFC 8628' },
  { id: 'scim', label: 'SCIM 2.0' },
] as const

export function CtaBandSection(): ReactNode {
  const probe = useEdgeProbeData()
  const specItems = [...SPEC_ITEMS, { id: 'signing', label: probe?.signingAlg ?? 'ES256' }] as const

  return (
    <section {...stylex.props(styles.band)}>
      <div {...stylex.props(shared.measure)}>
        <Reveal sx={styles.inner}>
          <div {...stylex.props(styles.specCol)}>
            <p {...stylex.props(shared.microlabel, styles.specHead)}>
              <Trans>Protocol surface</Trans>
            </p>
            <ul {...stylex.props(styles.specList)}>
              {specItems.map((item) => (
                <li key={item.id} {...stylex.props(styles.specItem)}>
                  <em {...stylex.props(styles.specSlash)} aria-hidden>
                    {'/'}
                  </em>
                  {item.label}
                </li>
              ))}
            </ul>
          </div>

          <div {...stylex.props(styles.copy)}>
            <h2 {...stylex.props(styles.heading)}>
              <Trans>Wire it once. Verify everywhere.</Trans>
            </h2>
            <p {...stylex.props(styles.sub)}>
              <Trans>
                One protocol across web, mobile, desktop, and server. 15 TypeScript SDKs, 13 native
                SDKs, one edge Worker.
              </Trans>
            </p>
            <div {...stylex.props(styles.ctaRow)}>
              <CtaLink
                href="/sign-up"
                variant="primary"
                size="lg"
                analyticsId="cta_band_start_integrating"
                analyticsPlacement="cta_band"
              >
                <Trans>Start integrating</Trans>
              </CtaLink>
              <a href={SOURCE_URL} {...stylex.props(styles.ghost)}>
                <Trans>Read the source</Trans>
                {' ->'}
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
