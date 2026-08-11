// account portal 壳:rail sticky,main 零 padding,gutter 由页面自持。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Link, useLocation } from '../../lib/router'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { page } from '../../styles/product-surface.stylex'
import { Button } from '../../components/ui'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { BrandLogo } from '../../components/BrandLogo'
import { useAuth } from '../../lib/auth-context'
import { useTheme } from '../../lib/theme'
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

const RAIL_WIDTH_DESKTOP = '13.5rem'
const TOPBAR_HEIGHT = '3rem'

const styles = stylex.create({
  root: {
    minHeight: '100dvh',
    display: 'grid',
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
  // 桌面 brand 由 rail 持有,topbar 只露右侧操作(zIndex 叠层)。
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
  },
  topbarActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginInlineStart: {
      default: 'auto',
      '@media (min-width: 48rem)': 'auto',
    },
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 48rem)': 'clamp(1rem, 2.5vw, 4rem)',
    },
  },
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
  tenantLogo: {
    height: '1.125rem',
    objectFit: 'contain',
  },
  userEmail: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '16rem',
  },
  // 小屏改为底部 sticky tab。
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
  // 透明占位防激活缘线跳动。
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
  const { brand } = useTheme()
  const { user, signOut } = useAuth()
  const appName = brand.appName ?? 'XID'
  const brandMark = brand.logoUrl ? (
    <img src={brand.logoUrl} alt={t`${appName} logo`} {...stylex.props(styles.tenantLogo)} />
  ) : (
    <BrandLogo variant="mark" height={18} />
  )
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.topbar)}>
        <span {...stylex.props(styles.topbarBrand)}>
          {brandMark}
          <span aria-hidden="true" {...stylex.props(styles.brandDivider)} />
          <span {...stylex.props(styles.brandLabel)}>
            <Trans>Account settings</Trans>
          </span>
        </span>
        <div {...stylex.props(styles.topbarActions)}>
          {user ? (
            <>
              <span {...stylex.props(styles.userEmail)}>{user.email}</span>
              <a href="/console" {...stylex.props(page.textLink)}>
                <Trans>Back to Console</Trans>
              </a>
              <Button variant="ghost" onClick={() => void signOut()} aria-label={t`Sign out`}>
                <Trans>Sign out</Trans>
              </Button>
            </>
          ) : null}
          <LanguageSwitcher />
        </div>
      </div>

      <nav aria-label={t`Account settings navigation`} {...stylex.props(styles.rail)}>
        <div {...stylex.props(styles.railBrand)}>
          {brandMark}
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
