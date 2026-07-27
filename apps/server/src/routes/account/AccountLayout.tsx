// AccountLayout:account portal 全宽壳。
// 锚定规范:rail 贴左全高 sticky(brand 驻栏顶与顶栏同高同底线),main 零 padding;
// 内容区 gutter 由各页面自持 clamp(1rem,2.5vw,4rem)。
// 小屏 rail 收为横向滚动 tab 栏(bottom),激活态 accent 缘线(桌面左缘 / 小屏底缘),不用底色块。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Link, useLocation } from '../../lib/router'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { BrandLogo } from '../../components/BrandLogo'
import { GuestConversionBanner } from './GuestConversionBanner'

export type AccountLayoutProps = {
  children: ReactNode
}

type NavItem = {
  to: string
  label: ReactNode
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/account', label: <Trans>Profile</Trans> },
  { to: '/account/security', label: <Trans>Security</Trans> },
  { to: '/account/connections', label: <Trans>Connected accounts</Trans> },
  { to: '/account/sessions', label: <Trans>Active sessions</Trans> },
  { to: '/account/devices', label: <Trans>Trusted devices</Trans> },
]

// 全宽规范口径:rail 宽、顶栏高与各页面对齐。
const RAIL_WIDTH_DESKTOP = '13.5rem'
const TOPBAR_HEIGHT = '3rem'

const styles = stylex.create({
  root: {
    minHeight: '100dvh',
    display: 'grid',
    // 桌面:rail + 内容区;小屏:单列(rail 在底部 sticky)
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': `${RAIL_WIDTH_DESKTOP} 1fr`,
    },
    gridTemplateRows: {
      default: `${TOPBAR_HEIGHT} 1fr auto`,
      '@media (min-width: 48rem)': `${TOPBAR_HEIGHT} 1fr`,
    },
    backgroundColor: tokens['--xid-bg'],
    fontFamily: tokens['--xid-font'],
  },
  // 顶栏:全宽横贯,brand + 操作区同行;下沿 1px hairline
  topbar: {
    gridColumn: '1 / -1',
    gridRow: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem 1rem',
    paddingBlock: '0',
    paddingInline: {
      default: 'clamp(1rem, 2.5vw, 4rem)',
      '@media (min-width: 48rem)': '0',
    },
    height: TOPBAR_HEIGHT,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    // 桌面下顶栏 brand 区由 rail 内部 brand 行持有,topbar 只露出右侧操作
    // 让 rail 自行覆盖顶栏左段:topbar 用 grid 叠层,rail 自带 zIndex
  },
  // 桌面顶栏右侧操作区(LanguageSwitcher)
  topbarActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    // 桌面:操作区在 rail 右侧,小屏:操作区与 brand 同行
    marginInlineStart: {
      default: 'auto',
      '@media (min-width: 48rem)': 'auto',
    },
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 48rem)': 'clamp(1rem, 2.5vw, 4rem)',
    },
  },
  // 小屏 brand 块(桌面下 rail 持 brand,此行隐藏)
  topbarBrand: {
    display: {
      default: 'inline-flex',
      '@media (min-width: 48rem)': 'none',
    },
    alignItems: 'center',
    gap: '0.625rem',
    minWidth: 0,
  },
  brandDivider: {
    width: '1px',
    height: '1rem',
    backgroundColor: tokens['--xid-border-strong'],
  },
  brandLabel: {
    fontSize: '0.8125rem',
    fontWeight: 550,
    color: tokens['--xid-fg'],
    whiteSpace: 'nowrap',
  },
  // Rail:贴左全高 sticky;小屏变为底部 sticky tab 栏
  rail: {
    gridRow: {
      default: '3',
      '@media (min-width: 48rem)': '1 / -1',
    },
    gridColumn: '1',
    position: 'sticky',
    top: {
      default: 'auto',
      '@media (min-width: 48rem)': '0',
    },
    bottom: {
      default: '0',
      '@media (min-width: 48rem)': 'auto',
    },
    height: {
      default: 'auto',
      '@media (min-width: 48rem)': '100dvh',
    },
    width: {
      default: '100%',
      '@media (min-width: 48rem)': RAIL_WIDTH_DESKTOP,
    },
    display: 'flex',
    flexDirection: {
      default: 'row',
      '@media (min-width: 48rem)': 'column',
    },
    backgroundColor: tokens['--xid-sidebar'],
    borderTopWidth: {
      default: '1px',
      '@media (min-width: 48rem)': '0',
    },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    borderRightWidth: {
      default: '0',
      '@media (min-width: 48rem)': '1px',
    },
    borderRightStyle: 'solid',
    borderRightColor: tokens['--xid-border'],
    zIndex: 10,
    overflowX: {
      default: 'auto',
      '@media (min-width: 48rem)': 'visible',
    },
    overflowY: {
      default: 'hidden',
      '@media (min-width: 48rem)': 'auto',
    },
  },
  // 桌面 rail 顶部 brand 行:与 topbar 同高同底线
  railBrand: {
    display: {
      default: 'none',
      '@media (min-width: 48rem)': 'flex',
    },
    alignItems: 'center',
    gap: '0.625rem',
    paddingInline: '1rem',
    height: TOPBAR_HEIGHT,
    flexShrink: 0,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  // 导航组标签:mono microlabel
  navGroupLabel: {
    display: {
      default: 'none',
      '@media (min-width: 48rem)': 'block',
    },
    paddingInline: '1rem',
    paddingTop: '1.25rem',
    paddingBottom: '0.5rem',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
  navList: {
    display: 'flex',
    flexDirection: {
      default: 'row',
      '@media (min-width: 48rem)': 'column',
    },
    gap: {
      default: '0',
      '@media (min-width: 48rem)': '0.125rem',
    },
    paddingInline: {
      default: '0.75rem',
      '@media (min-width: 48rem)': '0',
    },
    paddingBlock: {
      default: '0.5rem',
      '@media (min-width: 48rem)': '0',
    },
    flex: {
      default: '1',
      '@media (min-width: 48rem)': 'none',
    },
    minWidth: 0,
  },
  // main:零 padding;内容区 gutter 由页面自持
  main: {
    gridRow: {
      default: '2',
      '@media (min-width: 48rem)': '2',
    },
    gridColumn: {
      default: '1',
      '@media (min-width: 48rem)': '2',
    },
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  // 缘线激活指示:桌面 2px 左缘 / 小屏 2px 底缘;透明占位防跳动。
  navLink: {
    display: 'flex',
    alignItems: 'center',
    paddingBlock: {
      default: '0.5rem',
      '@media (min-width: 48rem)': '0.4375rem',
    },
    paddingInlineStart: {
      default: '0.5rem',
      '@media (min-width: 48rem)': 'calc(1rem - 2px)',
    },
    paddingInlineEnd: {
      default: '0.5rem',
      '@media (min-width: 48rem)': '1rem',
    },
    fontSize: '0.875rem',
    fontWeight: 450,
    lineHeight: 1.4,
    color: {
      default: tokens['--xid-muted-foreground'],
      ':hover': tokens['--xid-fg'],
    },
    textDecoration: 'none',
    whiteSpace: {
      default: 'nowrap',
      '@media (min-width: 48rem)': 'normal',
    },
    borderLeftWidth: {
      default: '0',
      '@media (min-width: 48rem)': '2px',
    },
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    borderBottomWidth: {
      default: '2px',
      '@media (min-width: 48rem)': '0',
    },
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    transitionProperty: 'color, border-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    borderRadius: {
      default: '0',
      '@media (min-width: 48rem)': '0',
    },
  },
  navLinkActive: {
    fontWeight: 550,
    color: tokens['--xid-fg'],
    borderLeftColor: tokens['--xid-accent'],
    borderBottomColor: tokens['--xid-accent'],
  },
})

const navLinkBase = stylex.props(styles.navLink).className ?? ''
const navLinkActive = stylex.props(styles.navLink, styles.navLinkActive).className ?? ''

export function AccountLayout({ children }: AccountLayoutProps): ReactNode {
  const { t } = useLingui()
  return (
    <div {...stylex.props(styles.root)}>
      {/* 顶栏:小屏 brand + 全局操作;桌面仅右侧操作(brand 由 rail 持有) */}
      <div {...stylex.props(styles.topbar)}>
        <span {...stylex.props(styles.topbarBrand)}>
          <BrandLogo variant="mark" height={18} />
          <span aria-hidden="true" {...stylex.props(styles.brandDivider)} />
          <span {...stylex.props(styles.brandLabel)}>
            <Trans>Account settings</Trans>
          </span>
        </span>
        <div {...stylex.props(styles.topbarActions)}>
          <LanguageSwitcher />
        </div>
      </div>

      {/* Rail:桌面贴左全高 sticky;小屏底部 sticky tab 栏 */}
      <nav aria-label={t`Account settings navigation`} {...stylex.props(styles.rail)}>
        {/* 桌面 brand 行:与 topbar 同高对齐 */}
        <div {...stylex.props(styles.railBrand)}>
          <BrandLogo variant="mark" height={18} />
          <span aria-hidden="true" {...stylex.props(styles.brandDivider)} />
          <span {...stylex.props(styles.brandLabel)}>
            <Trans>Account settings</Trans>
          </span>
        </div>

        <span {...stylex.props(styles.navGroupLabel)}>
          <Trans>Settings</Trans>
        </span>

        <div {...stylex.props(styles.navList)}>
          {NAV_ITEMS.map((item) => (
            <AccountNavLink key={String(item.to)} to={item.to} label={item.label} />
          ))}
        </div>
      </nav>

      {/* main:零 padding;页面自持 gutter */}
      <main {...stylex.props(styles.main)}>
        <GuestConversionBanner />
        {children}
      </main>
    </div>
  )
}

type AccountNavLinkProps = {
  to: string
  label: ReactNode
}

function AccountNavLink({ to, label }: AccountNavLinkProps): ReactNode {
  const location = useLocation()
  const isActive = to === '/account' ? location.pathname === to : location.pathname.startsWith(to)
  return (
    <Link to={to} className={isActive ? navLinkActive : navLinkBase}>
      {label}
    </Link>
  )
}
