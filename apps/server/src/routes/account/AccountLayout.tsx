// 账户门户外壳:≥48rem 左侧导航(租户、身份、5 个入口),工作区顶栏放控制台入口、语言与退出;
// <48rem 顶部一行租户与账户菜单,下方横向分段导航,5 项全部露出,当前项滚入视口。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { CONSOLE_EXACT_PATH } from '@xid-kit/types'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Link, useLocation } from '@xid-kit/web-ui/tanstack-router'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { Avatar, Button, Dropdown, Icon } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { useDefaultLandingPath } from '../../lib/default-landing'
import { brandLogoUrl, useTheme } from '../../lib/theme'
import { tokens } from '../../styles/tokens.stylex'
import { AccountIcon, type AccountIconName } from './account-icons'
import { ACCOUNT_PATHS } from './account-paths'
import { PendingDeletionBanner } from './PendingDeletionBanner'
import { StepUpProvider } from './step-up'

export type AccountLayoutProps = {
  children: ReactNode
}

type NavItem = {
  to: string
  icon: AccountIconName
  label: ReactNode
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: ACCOUNT_PATHS.profile, icon: 'profile', label: <Trans>Profile</Trans> },
  { to: ACCOUNT_PATHS.security, icon: 'security', label: <Trans>Security</Trans> },
  { to: ACCOUNT_PATHS.devices, icon: 'devices', label: <Trans>Devices</Trans> },
  { to: ACCOUNT_PATHS.organizations, icon: 'organizations', label: <Trans>Organizations</Trans> },
  { to: ACCOUNT_PATHS.privacy, icon: 'privacy', label: <Trans>Data & privacy</Trans> },
]

const styles = stylex.create({
  root: {
    minHeight: '100dvh',
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 48rem)': '14rem minmax(0, 1fr)',
      '@media (min-width: 64rem)': '15.5rem minmax(0, 1fr)',
    },
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  sidebar: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    flexDirection: 'column',
    position: 'sticky',
    top: 0,
    height: '100dvh',
    overflowY: 'auto',
    backgroundColor: tokens['--xid-sidebar'],
    borderInlineEndWidth: '1px',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
  },
  tenant: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    minHeight: '3.5rem',
    paddingInline: { default: '1rem', '@media (min-width: 48rem)': '1.25rem' },
    minWidth: 0,
  },
  tenantMark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
    fontSize: text.xs,
    fontWeight: 600,
    overflow: 'hidden',
  },
  tenantLogo: {
    width: '1.5rem',
    height: '1.5rem',
    objectFit: 'contain',
    flexShrink: 0,
  },
  tenantText: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  tenantName: {
    fontSize: text.base,
    lineHeight: '1.125rem',
    fontWeight: weight.medium,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  tenantCaption: {
    fontSize: text.xs,
    lineHeight: leading.xs,
    letterSpacing: tokens['--xid-tracking-small'],
    color: tokens['--xid-muted-foreground'],
  },
  identity: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '1.25rem',
    borderBlockWidth: '1px',
    borderBlockStyle: 'solid',
    borderBlockColor: tokens['--xid-border'],
    minWidth: 0,
  },
  identityText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  identityName: {
    fontSize: text.base,
    lineHeight: '1.125rem',
    fontWeight: weight.medium,
    overflowWrap: 'anywhere',
  },
  identityEmail: {
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: tokens['--xid-muted-foreground'],
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    paddingBlock: '1rem',
    paddingInline: '0.75rem',
  },
  navLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    minHeight: { default: '2.25rem', '@media (pointer: coarse)': '2.75rem' },
    paddingInline: '0.625rem',
    borderRadius: tokens['--xid-radius'],
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    fontSize: text.base,
    lineHeight: '1.125rem',
    textDecoration: 'none',
  },
  navLinkActive: {
    backgroundColor: tokens['--xid-surface'],
    boxShadow: `0 0 0 1px ${tokens['--xid-border']}`,
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  workspace: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  topbar: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    minHeight: '3.5rem',
    paddingInlineStart: { default: '2.5rem', '@media (min-width: 64rem)': '4rem' },
    paddingInlineEnd: '1.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  topbarActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    marginInlineStart: 'auto',
  },
  backLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    color: tokens['--xid-accent'],
    fontSize: text.sm,
    lineHeight: leading.sm,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  mobileHeader: {
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    flexDirection: 'column',
    position: 'sticky',
    top: 0,
    zIndex: 10,
    backgroundColor: tokens['--xid-sidebar'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  mobileTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    minHeight: '3.5rem',
    paddingInlineEnd: '0.375rem',
  },
  menuTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '2.75rem',
    height: '2.75rem',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    borderRadius: tokens['--xid-radius-full'],
    cursor: 'pointer',
  },
  segmented: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '1.25rem',
    paddingInline: '1rem',
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  segment: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    minHeight: '2.75rem',
    borderBottomWidth: '2px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: '1.125rem',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
  },
  segmentActive: {
    borderBottomColor: tokens['--xid-fg'],
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  mobileFooter: {
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    justifyContent: 'flex-start',
    paddingInline: '1rem',
    paddingBlockEnd: 'max(1.5rem, env(safe-area-inset-bottom))',
  },
})

function isActivePath(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}

function TenantBlock(): ReactNode {
  const { t } = useLingui()
  const { brand, scheme } = useTheme()
  const appName = brand.appName ?? 'XID'
  const logoUrl = brandLogoUrl(brand, scheme)
  return (
    <div {...stylex.props(styles.tenant)}>
      {logoUrl ? (
        <img src={logoUrl} alt={t`${appName} logo`} {...stylex.props(styles.tenantLogo)} />
      ) : (
        <span aria-hidden="true" {...stylex.props(styles.tenantMark)}>
          {appName.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span {...stylex.props(styles.tenantText)}>
        <span {...stylex.props(styles.tenantName)}>{appName}</span>
        <span {...stylex.props(styles.tenantCaption)}>
          <Trans>Your account</Trans>
        </span>
      </span>
    </div>
  )
}

function useIdentity(): { name: string; caption: string; imageUrl: string | null } | null {
  const { t } = useLingui()
  const { user } = useAuth()
  if (!user) return null
  if (isGuestUser(user)) {
    return { name: t`Guest`, caption: t`No email or passkey yet`, imageUrl: null }
  }
  return { name: user.name ?? user.email, caption: user.email, imageUrl: user.imageUrl }
}

function useConsoleLink(): boolean {
  const { user, organizations, managerAssignments } = useAuth()
  const defaultLandingPath = useDefaultLandingPath()
  // Console 只对确有管理入口的用户显示,纯成员进去会被送回账户门户。
  const hasConsoleAccess =
    user?.instanceManager === true ||
    managerAssignments.length > 0 ||
    organizations.some((organization) => isOrgManagerRole(organization.role))
  return defaultLandingPath === CONSOLE_EXACT_PATH && hasConsoleAccess
}

function SidebarNav(): ReactNode {
  const { t } = useLingui()
  const location = useLocation()
  return (
    <nav aria-label={t`Account`} {...stylex.props(styles.nav)}>
      {NAV_ITEMS.map((item) => {
        const active = isActivePath(location.pathname, item.to)
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            {...stylex.props(styles.navLink, active && styles.navLinkActive)}
          >
            <AccountIcon name={item.icon} />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

function SegmentedNav(): ReactNode {
  const { t } = useLingui()
  const location = useLocation()
  const navRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [location.pathname])
  return (
    <nav ref={navRef} aria-label={t`Account`} {...stylex.props(styles.segmented)}>
      {NAV_ITEMS.map((item) => {
        const active = isActivePath(location.pathname, item.to)
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            {...stylex.props(styles.segment, active && styles.segmentActive)}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

function AccountMenu(): ReactNode {
  const { t } = useLingui()
  const { user, signOut } = useAuth()
  const identity = useIdentity()
  const showConsoleLink = useConsoleLink()
  if (!user || !identity) return null
  return (
    <Dropdown
      ariaLabel={t`Account menu`}
      align="end"
      triggerStyle={styles.menuTrigger}
      trigger={<Avatar name={identity.name} src={identity.imageUrl} size="md" />}
      header={identity.caption}
      items={[
        ...(showConsoleLink
          ? [{ key: 'console', label: <Trans>Open console</Trans>, href: CONSOLE_EXACT_PATH }]
          : []),
        { key: 'sign-out', label: <Trans>Sign out</Trans>, onSelect: () => void signOut() },
      ]}
    />
  )
}

export function AccountLayout({ children }: AccountLayoutProps): ReactNode {
  const { t } = useLingui()
  const { user, signOut, status } = useAuth()
  const identity = useIdentity()
  const showConsoleLink = useConsoleLink()
  const canSignOut = Boolean(user) || status === 'pending_mfa_setup'

  return (
    <StepUpProvider>
      <div {...stylex.props(styles.root)}>
        <aside {...stylex.props(styles.sidebar)}>
          <TenantBlock />
          {identity ? (
            <div {...stylex.props(styles.identity)}>
              <Avatar name={identity.name} src={identity.imageUrl} size="lg" />
              <span {...stylex.props(styles.identityText)}>
                <span {...stylex.props(styles.identityName)}>{identity.name}</span>
                {identity.caption === identity.name ? null : (
                  <span {...stylex.props(styles.identityEmail)}>{identity.caption}</span>
                )}
              </span>
            </div>
          ) : null}
          <SidebarNav />
        </aside>

        <div {...stylex.props(styles.workspace)}>
          <header {...stylex.props(styles.mobileHeader)}>
            <div {...stylex.props(styles.mobileTop)}>
              <TenantBlock />
              <AccountMenu />
            </div>
            <SegmentedNav />
          </header>

          <div {...stylex.props(styles.topbar)}>
            {showConsoleLink ? (
              <a href={CONSOLE_EXACT_PATH} {...stylex.props(styles.backLink)}>
                <Icon name="chevron-left" size={16} />
                <Trans>Back to Console</Trans>
              </a>
            ) : null}
            <div {...stylex.props(styles.topbarActions)}>
              <LanguageSwitcher />
              {canSignOut ? (
                <Button variant="ghost" onClick={() => void signOut()} aria-label={t`Sign out`}>
                  <Trans>Sign out</Trans>
                </Button>
              ) : null}
            </div>
          </div>

          <PendingDeletionBanner />
          <main {...stylex.props(styles.main)}>{children}</main>
          <div {...stylex.props(styles.mobileFooter)}>
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </StepUpProvider>
  )
}
