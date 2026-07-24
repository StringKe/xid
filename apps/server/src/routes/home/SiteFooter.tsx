// SiteFooter:全宽多列页脚。贴边协议账本语言:顶 hairline 分节,
// 品牌栏占 5 列,三栏链接目录各占 7/3 分配。
// 窄屏 <=48rem 折为 1fr 1fr 双列;超窄 <=28rem 单列。
// meta 行贴底:license + 年份,mono 微字,左右各持页边距。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { BrandLogo } from '../../components/BrandLogo'
import { trackNavClick } from '../../lib/google-analytics-funnel'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'

const CURRENT_YEAR = new Date().getFullYear()
const SOURCE_URL = 'https://github.com/StringKe/xid'
const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`

const styles = stylex.create({
  foot: {
    backgroundColor: tokens['--xid-sidebar'],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  // 主列区:一行全宽网格,品牌 5fr + 三目录列各分 7fr
  cols: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 5fr) repeat(3, minmax(0, 1fr))',
      '@media (max-width: 52rem)': 'minmax(0, 1fr) minmax(0, 1fr)',
      '@media (max-width: 28rem)': 'minmax(0, 1fr)',
    },
    paddingBlock: 'clamp(2.5rem, 4.5vw, 4.5rem)',
    gap: 'clamp(1.5rem, 3vw, 2.5rem)',
  },
  // 品牌列:logo + 一句话描述
  brand: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
    // 窄屏合并 span 全行
    gridColumn: {
      default: 'auto',
      '@media (max-width: 52rem)': '1 / -1',
    },
    // hairline 邻接口径:窄屏品牌描述与下方分隔线距离 >= 1.25rem。
    paddingBottom: {
      default: '0',
      '@media (max-width: 52rem)': 'clamp(1.25rem, 2vw, 1.75rem)',
    },
    borderBottomWidth: '1px',
    borderBottomStyle: {
      default: 'none',
      '@media (max-width: 52rem)': 'solid',
    },
    borderBottomColor: lx.hairline,
  },
  brandLink: {
    display: 'inline-flex',
    alignItems: 'center',
    textDecorationLine: 'none',
    alignSelf: 'flex-start',
  },
  brandNote: {
    fontSize: '0.875rem',
    lineHeight: 1.6,
    color: lx.secondary,
    margin: 0,
    maxWidth: '32ch',
    textWrap: 'pretty',
  },
  // 单链接列
  col: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
  },
  // microlabel 口径(shared.microlabel)+ 栏头排距。
  colHead: {
    margin: '0 0 1rem',
  },
  colLink: {
    display: 'block',
    color: {
      default: lx.secondary,
      ':hover': lx.primary,
    },
    textDecorationLine: 'none',
    fontSize: '0.9375rem',
    paddingBlock: '0.3125rem',
    transitionProperty: 'color',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  // meta 行:hairline 顶线 + license + 年份;文字走 microlabel 口径,此处只管布局。
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '0.75rem',
    paddingBlock: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
})

type FooterLink = { href: string; label: ReactNode }
type FooterColumn = { id: string; heading: ReactNode; links: readonly FooterLink[] }

function useFooterColumns(): readonly FooterColumn[] {
  const { t } = useLingui()
  return [
    {
      id: 'product',
      heading: <Trans>Product</Trans>,
      links: [
        { href: '/docs/oidc-oauth', label: 'OIDC / OAuth' },
        { href: '/docs/management-api', label: t`Organization RBAC` },
        { href: '/docs/enterprise-sso', label: t`Enterprise SSO` },
        { href: '/docs/hosted-auth', label: t`Passkeys` },
        { href: '/docs/sdks', label: t`SDK matrix` },
      ],
    },
    {
      id: 'developers',
      heading: <Trans>Developers</Trans>,
      links: [
        { href: '/docs', label: t`Documentation` },
        { href: '/docs/sdks', label: t`SDK reference` },
        { href: '/docs/self-hosting', label: t`Self-hosting` },
        { href: '/docs/scim', label: t`Directory sync` },
        { href: '/docs/social-login', label: t`Social login` },
      ],
    },
    {
      id: 'company',
      heading: <Trans>Company</Trans>,
      links: [
        { href: SOURCE_URL, label: t`Source code` },
        { href: LICENSE_URL, label: t`License` },
        { href: `${SOURCE_URL}/issues`, label: t`Contact` },
      ],
    },
  ]
}

export function SiteFooter(): ReactNode {
  const columns = useFooterColumns()
  return (
    <footer {...stylex.props(styles.foot)}>
      <div {...stylex.props(shared.measure)}>
        <div {...stylex.props(styles.cols)}>
          <div {...stylex.props(styles.brand)}>
            <a href="/" aria-label="XID" {...stylex.props(styles.brandLink)}>
              <BrandLogo height={26} />
            </a>
            <p {...stylex.props(styles.brandNote)}>
              <Trans>Identity infrastructure that signs and verifies on the edge.</Trans>
            </p>
          </div>
          {columns.map((column) => (
            <nav
              key={column.id}
              aria-labelledby={`footer-col-${column.id}`}
              {...stylex.props(styles.col)}
            >
              <h3
                id={`footer-col-${column.id}`}
                {...stylex.props(shared.microlabel, styles.colHead)}
              >
                {column.heading}
              </h3>
              {column.links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() =>
                    trackNavClick({
                      linkId: `${column.id}:${link.href}`,
                      href: link.href,
                      placement: 'site_footer',
                    })
                  }
                  {...stylex.props(styles.colLink)}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          ))}
        </div>
        <div {...stylex.props(shared.microlabel, styles.meta)}>
          <span>
            <Trans>XID. Identity infrastructure on the edge.</Trans>
          </span>
          <span>{`MIT · © ${CURRENT_YEAR}`}</span>
        </div>
      </div>
    </footer>
  )
}
