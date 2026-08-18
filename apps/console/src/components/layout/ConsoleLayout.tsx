// org/instance 共用全宽壳;nav 由调用方按角色注入(铁律 8 不另建 admin 壳)。
// 桌面端侧栏主导:org 切换在 rail 顶部,用户菜单在 rail 底部;移动端用单一当前页菜单。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { isGuestUser } from '@xid-kit/web-ui/session'
import type { AuthOrg, AuthUser } from '@xid-kit/web-ui/session'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { motion, springDefault } from '@xid-kit/web-ui/motion'
import { useTheme } from '@xid-kit/web-ui/theme'
import { BrandLogo } from '@xid-kit/web-ui/BrandLogo'
import { LanguageSwitcher } from '../LanguageSwitcher'
import { Alert, Button, Dropdown, Icon, Spinner } from '@xid-kit/web-ui/ui'
import {
  returnFromImpersonation,
  type ImpersonationEndResponse,
} from '../../lib/impersonation-handoff'
import { ActiveAnnouncementsBanner } from '../ActiveAnnouncementsBanner'
import type { ConsoleNavItem } from '../../nav'

export type { ConsoleNavItem } from '../../nav'

export type ConsoleLayoutProps = {
  children: ReactNode
  navItems: readonly ConsoleNavItem[]
}

// 页面节与移动端顶栏共用 gutter;rail 内统一 0.75rem 内边距 + 0.625rem 项内距 = 1.375rem 对齐线。
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const BAR_MIN_HEIGHT = '3.5rem'

const styles = stylex.create({
  shell: {
    minHeight: '100dvh',
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': '16rem minmax(0, 1fr)',
      '@media (min-width: 120rem)': '18rem minmax(0, 1fr)',
    },
    gridTemplateRows: {
      default: 'auto auto 1fr',
      // 桌面无顶栏,内容区独占一行。
      '@media (min-width: 48rem)': '1fr',
    },
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  // 顶栏只在移动端存在:brand + org 切换 + 用户头像菜单。
  header: {
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    gridColumn: '1',
    gridRow: '1',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem 1.5rem',
    minHeight: BAR_MIN_HEIGHT,
    paddingBlock: '0.5rem',
    paddingInline: GUTTER,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  headerContext: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minWidth: 0,
  },
  // display 互斥:任一断点 AT 只见一份 brand/控件,避免双读。
  brandNarrow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontWeight: 600,
    fontSize: '0.9375rem',
  },
  brandLogo: {
    display: 'inline-flex',
    flexShrink: 0,
  },
  orgTrigger: {
    gap: '0.5rem',
    minWidth: 0,
    maxWidth: 'min(20rem, 56vw)',
    paddingBlock: '0.25rem',
    paddingInline: '0.375rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':focus-visible': tokens['--xid-muted'],
    },
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
  },
  // rail 顶部的整行切换器:与导航项同一条 1.375rem 对齐线。
  orgTriggerRail: {
    gap: '0.5rem',
    width: '100%',
    minWidth: 0,
    paddingBlock: '0.4375rem',
    paddingInline: '0.625rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':focus-visible': tokens['--xid-muted'],
    },
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
  },
  orgAvatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.5rem',
    flexShrink: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-accent'],
    color: tokens['--xid-primary-foreground'],
    fontSize: '0.6875rem',
    fontWeight: 650,
    textTransform: 'uppercase',
  },
  orgName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8125rem',
    fontWeight: 550,
    color: tokens['--xid-fg'],
  },
  caret: {
    display: 'inline-flex',
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
  },
  caretEnd: {
    marginInlineStart: 'auto',
  },
  caretOpen: {
    transform: 'rotate(180deg)',
  },
  // 无 org 时不用 disabled 控件(永不可用),改静态文案。
  orgEmpty: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    whiteSpace: 'nowrap',
  },
  userArea: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.5rem 1rem',
    minWidth: 0,
  },
  userTrigger: {
    borderRadius: tokens['--xid-radius-full'],
  },
  userAvatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.75rem',
    height: '1.75rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
    fontSize: '0.6875rem',
    fontWeight: 650,
    textTransform: 'uppercase',
  },
  aside: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    gridColumn: '1',
    gridRow: '1 / -1',
    backgroundColor: tokens['--xid-sidebar'],
    borderInlineEndWidth: '1px',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
    minWidth: 0,
  },
  railPin: {
    position: {
      default: 'static',
      '@media (min-width: 48rem)': 'sticky',
    },
    top: 0,
    maxHeight: {
      default: 'none',
      '@media (min-width: 48rem)': '100dvh',
    },
    height: { default: 'auto', '@media (min-width: 48rem)': '100dvh' },
    display: 'flex',
    flexDirection: 'column',
  },
  // rail 头部:brand 行 + org 切换器,与导航共用对齐线;仅桌面。
  sidebarHead: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    flexDirection: 'column',
    gap: '0.25rem',
    paddingBlock: '0.5rem 0.75rem',
    paddingInline: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    flexShrink: 0,
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minHeight: '2.25rem',
    paddingInline: '0.625rem',
    fontWeight: 600,
    fontSize: '0.9375rem',
  },
  navRegion: {
    minHeight: 0,
    padding: '1.25rem 0.75rem',
    overflowX: 'hidden',
    overflowY: 'auto',
    flexGrow: 1,
  },
  navList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    flexWrap: 'wrap',
    gap: '0.125rem',
  },
  // 桌面端 hover 只改文字色:背景块是激活态专属,hover 出块会与激活块撞色。
  navLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    position: 'relative',
    paddingBlock: '0.4375rem',
    paddingInline: '0.625rem',
    color: {
      default: tokens['--xid-muted-foreground'],
      ':hover': tokens['--xid-fg'],
      ':focus-visible': tokens['--xid-fg'],
    },
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: tokens['--xid-muted'],
        '@media (min-width: 48rem)': 'transparent',
      },
      ':focus-visible': {
        default: tokens['--xid-muted'],
        '@media (min-width: 48rem)': 'transparent',
      },
    },
    textDecoration: 'none',
    fontSize: '0.8125rem',
    fontWeight: 450,
    whiteSpace: 'normal',
    // 仅过渡色;激活块位移走 motion,勿放进 CSS transition。
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
    borderRadius: tokens['--xid-radius-sm'],
    outlineOffset: '2px',
    outlineColor: tokens['--xid-primary'],
  },
  navLinkActive: {
    color: tokens['--xid-fg'],
    fontWeight: 550,
  },
  navIcon: {
    display: 'inline-flex',
    flexShrink: 0,
  },
  navItem: {
    position: 'relative',
  },
  // 桌面 rail:激活=muted 圆角块 + 左侧 1px 品牌指示条,layoutId 在项间滑动。
  navIndicatorRail: {
    display: 'block',
    position: 'absolute',
    inset: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-muted'],
    boxShadow: `inset 1px 0 0 ${tokens['--xid-primary']}`,
    pointerEvents: 'none',
  },
  // paddingTop 1.25rem:label 与上方 hairline 邻接距离下限。
  navGroupLabel: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    margin: 0,
    paddingInline: '0.625rem',
    paddingTop: '1.25rem',
    paddingBottom: '0.375rem',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  // marginBlockStart 0.875rem + navLink padding 凑满 hairline 邻接 1.25rem。
  navGroupDivider: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    marginBlockStart: '0.875rem',
    marginBlockEnd: '0',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  // rail footer 只服务桌面侧栏;移动端横向导航里放 footer 会挤占 tab 空间。
  railFooter: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    flexDirection: 'column',
    gap: '0.125rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.75rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    flexShrink: 0,
  },
  footerLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    paddingBlock: '0.4375rem',
    paddingInline: '0.625rem',
    borderRadius: tokens['--xid-radius-sm'],
    color: {
      default: tokens['--xid-muted-foreground'],
      ':hover': tokens['--xid-fg'],
      ':focus-visible': tokens['--xid-fg'],
    },
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':focus-visible': tokens['--xid-muted'],
    },
    textDecoration: 'none',
    fontSize: '0.8125rem',
    fontWeight: 450,
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
    outlineOffset: '2px',
    outlineColor: tokens['--xid-primary'],
  },
  footerLinkExternal: {
    display: 'inline-flex',
    marginInlineStart: 'auto',
  },
  footerLanguage: {
    paddingBlock: '0.4375rem',
    paddingInline: '0.625rem',
  },
  footerUser: {
    marginBlockStart: '0.375rem',
    paddingInline: '0.625rem',
  },
  mobileNavigation: {
    display: { default: 'block', '@media (min-width: 48rem)': 'none' },
    gridColumn: '1',
    gridRow: '2',
    paddingBlock: '0.625rem',
    paddingInline: GUTTER,
    backgroundColor: tokens['--xid-sidebar'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  mobileNavTrigger: {
    gap: '0.625rem',
    minHeight: '2.75rem',
    paddingBlock: '0.5rem',
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
  },
  mobileNavLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens['--xid-fg'],
    fontSize: '0.875rem',
    fontWeight: 550,
  },
  content: {
    gridColumn: { default: '1', '@media (min-width: 48rem)': '2' },
    gridRow: { default: '3', '@media (min-width: 48rem)': '1 / -1' },
    backgroundColor: tokens['--xid-bg'],
    minWidth: 0,
  },
  verificationBand: {
    paddingBlock: '0.75rem',
    paddingInline: GUTTER,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
  },
  verificationNotice: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 48rem)': 'row' },
    alignItems: { default: 'stretch', '@media (min-width: 48rem)': 'center' },
    gap: '0.75rem',
  },
  verificationMessage: {
    flexGrow: 1,
    minWidth: 0,
  },
})

const navLinkBase = stylex.props(styles.navLink).className ?? ''
const navLinkActive = stylex.props(styles.navLink, styles.navLinkActive).className ?? ''

function navItemActive(pathname: string, item: ConsoleNavItem): boolean {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

function navItemTo(item: ConsoleNavItem, search: string): string {
  if (!item.to.startsWith('/console/org')) return item.to
  // 只透传 orgId,勿把列表页 cursor/filter 带到下一页。
  const match = /(?:^|&)orgId=([^&]*)/.exec(search.startsWith('?') ? search.slice(1) : search)
  return match ? `${item.to}?orgId=${match[1]}` : item.to
}

// 首字母方块/圆头像的字母取自原始 name/slug/email,不取 displayName(可能是 Trans 节点)。
function firstLetter(value: string | null | undefined): string {
  const letter = value?.trim().charAt(0)
  return letter ? letter.toUpperCase() : '?'
}

// 相邻相同 groupKey 合并为段;无 key 的项各自独段(ReactNode 无法用 === 比分组)。
type NavSegment = { key: string | null; label: ReactNode; items: readonly ConsoleNavItem[] }

function segmentNavItems(items: readonly ConsoleNavItem[]): readonly NavSegment[] {
  const segments: NavSegment[] = []
  for (const item of items) {
    const last = segments[segments.length - 1]
    if (last && last.key !== null && last.key === item.groupKey) {
      segments[segments.length - 1] = { ...last, items: [...last.items, item] }
    } else {
      segments.push({
        key: item.groupKey ?? null,
        label: item.groupLabel ?? null,
        items: [item],
      })
    }
  }
  return segments
}

// layoutId 跨路由重挂载仍接续动画,reduced-motion 由 motion 瞬时处理。
function ActiveNavIndicator(): ReactNode {
  return (
    <motion.span
      aria-hidden="true"
      layoutId="console-nav-rail"
      transition={springDefault}
      {...stylex.props(styles.navIndicatorRail)}
    />
  )
}

function ConsoleNavLi({ item, search }: { item: ConsoleNavItem; search: string }): ReactNode {
  const location = useLocation()
  const active = navItemActive(location.pathname, item)
  const href = navItemTo(item, search)
  return (
    <li {...stylex.props(styles.navItem)}>
      {active ? <ActiveNavIndicator /> : null}
      <Link to={href} className={active ? navLinkActive : navLinkBase}>
        {item.icon ? (
          <span aria-hidden="true" {...stylex.props(styles.navIcon)}>
            <Icon name={item.icon} size={16} />
          </span>
        ) : null}
        {item.label}
      </Link>
    </li>
  )
}

function ConsoleNav({
  navItems,
  isInstanceManager,
}: {
  navItems: readonly ConsoleNavItem[]
  isInstanceManager: boolean
}): ReactNode {
  const location = useLocation()
  // 以带 end 的 /console/platform 识别 platform 区,避免再挂一条同路径项导致双指示条。
  const isPlatformNav = navItems.some((item) => item.to === '/console/platform' && item.end)
  return (
    <nav>
      {isPlatformNav ? (
        <>
          <ul {...stylex.props(styles.navList)}>
            <ConsoleNavLi
              item={{
                to: '/console',
                label: <Trans>Back to console</Trans>,
                icon: 'arrow-left',
                end: true,
              }}
              search={location.search}
            />
          </ul>
          <div aria-hidden="true" {...stylex.props(styles.navGroupDivider)} />
        </>
      ) : null}
      {segmentNavItems(navItems).map((segment, segIdx) => (
        <div key={segment.key ?? segIdx}>
          {segIdx > 0 && segment.key !== null ? (
            <div aria-hidden="true" {...stylex.props(styles.navGroupDivider)} />
          ) : null}
          {segment.key !== null && segment.label !== null ? (
            <p {...stylex.props(styles.navGroupLabel)}>{segment.label}</p>
          ) : null}
          <ul {...stylex.props(styles.navList)}>
            {segment.items.map((item) => (
              <ConsoleNavLi key={item.to} item={item} search={location.search} />
            ))}
          </ul>
        </div>
      ))}
      {isInstanceManager && !isPlatformNav ? (
        <div>
          <div aria-hidden="true" {...stylex.props(styles.navGroupDivider)} />
          <p {...stylex.props(styles.navGroupLabel)}>
            <Trans>Platform</Trans>
          </p>
          <ul {...stylex.props(styles.navList)}>
            <ConsoleNavLi
              item={{
                to: '/console/platform',
                label: <Trans>Platform management</Trans>,
                icon: 'shield-check',
              }}
              search={location.search}
            />
          </ul>
        </div>
      ) : null}
    </nav>
  )
}

function MobileConsoleNavigation({
  navItems,
  isInstanceManager,
}: {
  navItems: readonly ConsoleNavItem[]
  isInstanceManager: boolean
}): ReactNode {
  const { t } = useLingui()
  const location = useLocation()
  const navigate = useNavigate()
  const isPlatformNav = navItems.some((item) => item.to === '/console/platform' && item.end)
  const contextualItems: readonly ConsoleNavItem[] = [
    ...(isPlatformNav
      ? [
          {
            to: '/console',
            label: <Trans>Back to console</Trans>,
            icon: 'arrow-left' as const,
            end: true,
          },
        ]
      : []),
    ...navItems,
    ...(isInstanceManager && !isPlatformNav
      ? [
          {
            to: '/console/platform',
            label: <Trans>Platform management</Trans>,
            icon: 'shield-check' as const,
          },
        ]
      : []),
  ]
  const currentItem =
    contextualItems.find((item) => navItemActive(location.pathname, item)) ?? contextualItems[0]

  if (!currentItem) return null

  return (
    <nav aria-label={t`Primary navigation`} {...stylex.props(styles.mobileNavigation)}>
      <Dropdown
        ariaLabel={t`Primary navigation`}
        fullWidth
        triggerStyle={styles.mobileNavTrigger}
        trigger={({ open }) => (
          <>
            {currentItem.icon ? (
              <span aria-hidden="true" {...stylex.props(styles.navIcon)}>
                <Icon name={currentItem.icon} size={17} />
              </span>
            ) : null}
            <span {...stylex.props(styles.mobileNavLabel)}>{currentItem.label}</span>
            <span aria-hidden="true" {...stylex.props(styles.caret, open && styles.caretOpen)}>
              <Icon name="caret-down" size={14} />
            </span>
          </>
        )}
        items={contextualItems.map((item) => ({
          key: item.to,
          label: item.label,
          icon: item.icon,
          checked: navItemActive(location.pathname, item),
          onSelect: () => navigate(navItemTo(item, location.search)),
        }))}
      />
    </nav>
  )
}

function BrandMark({ appName }: { appName: string }): ReactNode {
  return (
    <>
      <span {...stylex.props(styles.brandLogo)}>
        <BrandLogo variant="mark" height={24} />
      </span>
      <span>{appName}</span>
    </>
  )
}

// org 切换器在移动端顶栏与桌面 rail 顶部各渲染一份(display 互斥);fullWidth 对应 rail 整行触发器。
function OrganizationMenu({
  manageableOrganizations,
  activeOrg,
  disabled,
  onSwitch,
  fullWidth = false,
}: {
  manageableOrganizations: readonly AuthOrg[]
  activeOrg: AuthOrg | null
  disabled: boolean
  onSwitch: (organizationId: string) => void
  fullWidth?: boolean
}): ReactNode {
  const { t } = useLingui()
  if (manageableOrganizations.length === 0) {
    return (
      <span {...stylex.props(styles.orgEmpty)}>
        <Trans>No organization selected</Trans>
      </span>
    )
  }
  return (
    <Dropdown
      ariaLabel={t`Switch organization`}
      align="start"
      fullWidth={fullWidth}
      triggerStyle={fullWidth ? styles.orgTriggerRail : styles.orgTrigger}
      disabled={disabled}
      trigger={
        <>
          <span aria-hidden="true" {...stylex.props(styles.orgAvatar)}>
            {activeOrg ? (
              firstLetter(activeOrg.name ?? activeOrg.slug)
            ) : (
              <Icon name="building" size={14} />
            )}
          </span>
          <span {...stylex.props(styles.orgName)}>
            {activeOrg ? organizationDisplayName(activeOrg) : <Trans>Select organization</Trans>}
          </span>
          <span aria-hidden="true" {...stylex.props(styles.caret, fullWidth && styles.caretEnd)}>
            <Icon name="caret-down" size={14} />
          </span>
        </>
      }
      items={manageableOrganizations.map((organization) => ({
        key: organization.id,
        label: organizationDisplayName(organization),
        checked: organization.id === activeOrg?.id,
        onSelect: () => onSwitch(organization.id),
      }))}
    />
  )
}

// 用户菜单在移动端顶栏(向下)与桌面 rail 底部(向上)各渲染一份;触发器只放头像,邮箱收进菜单头部。
function UserMenu({
  user,
  onSignOut,
  side = 'bottom',
  align = 'end',
}: {
  user: AuthUser
  onSignOut: () => void
  side?: 'bottom' | 'top'
  align?: 'start' | 'end'
}): ReactNode {
  const { t } = useLingui()
  return (
    <Dropdown
      ariaLabel={t`Account menu`}
      align={align}
      side={side}
      header={user.email}
      triggerStyle={styles.userTrigger}
      trigger={
        <span aria-hidden="true" {...stylex.props(styles.userAvatar)}>
          {firstLetter(user.name ?? user.email)}
        </span>
      }
      items={[
        {
          key: 'account',
          label: <Trans>Account settings</Trans>,
          icon: 'user-circle',
          href: '/account',
        },
        {
          key: 'sign-out',
          label: <Trans>Sign out</Trans>,
          icon: 'sign-out',
          onSelect: () => void onSignOut(),
        },
      ]}
    />
  )
}

export function ConsoleLayout({ children, navItems }: ConsoleLayoutProps): ReactNode {
  const { brand } = useTheme()
  const {
    status,
    user,
    activeOrg,
    organizations,
    managerAssignments,
    session,
    api,
    refresh,
    setActiveOrganization,
    signOut,
    openEmailVerification,
  } = useAuth()
  const { t } = useLingui()
  const location = useLocation()
  const navigate = useNavigate()
  const [switchingOrganizationId, setSwitchingOrganizationId] = useState<string | null>(null)
  const [endingImpersonation, setEndingImpersonation] = useState(false)
  const appName = brand.appName ?? 'XID'

  // 无 manager assignment 时隐藏 Managed projects(页内无内容)。
  const visibleNavItems = navItems.filter(
    (item) => item.to !== '/console/managed-projects' || managerAssignments.length > 0,
  )
  // 只列可管理 org;切到 member 会被守卫踢到 /account。
  const manageableOrganizations = organizations.filter((organization) =>
    isOrgManagerRole(organization.role),
  )
  const organizationSwitchDisabled =
    status !== 'authenticated' ||
    switchingOrganizationId !== null ||
    session?.isImpersonation === true

  async function switchOrganization(organizationId: string): Promise<void> {
    if (!organizationId || organizationId === activeOrg?.id) return
    setSwitchingOrganizationId(organizationId)
    const switched = await setActiveOrganization(organizationId)
    setSwitchingOrganizationId(null)
    if (!switched) return
    // org 区切换落到 overview;其他区保留当前路径,避免上下文被硬切。
    if (location.pathname.startsWith('/console/org')) {
      navigate(`/console/org?orgId=${encodeURIComponent(organizationId)}`, { replace: true })
    }
  }

  async function endImpersonation(): Promise<void> {
    if (endingImpersonation) return
    setEndingImpersonation(true)
    const ended = await api.post<ImpersonationEndResponse>('/auth/impersonation/end')
    if (ended.ok) {
      if (!returnFromImpersonation(ended.value.redirectUrl)) {
        await refresh()
        navigate('/console', { replace: true })
      }
    }
    setEndingImpersonation(false)
  }

  return (
    <div
      data-smoke-authenticated-console={status === 'authenticated' ? 'true' : undefined}
      {...stylex.props(styles.shell)}
    >
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerContext)}>
          <span {...stylex.props(styles.brandNarrow)}>
            <BrandMark appName={appName} />
          </span>
          <OrganizationMenu
            manageableOrganizations={manageableOrganizations}
            activeOrg={activeOrg}
            disabled={organizationSwitchDisabled}
            onSwitch={(organizationId) => void switchOrganization(organizationId)}
          />
        </div>

        <div {...stylex.props(styles.userArea)}>
          <LanguageSwitcher />
          {status === 'loading' ? (
            <Spinner size={16} />
          ) : user ? (
            <UserMenu user={user} onSignOut={() => void signOut()} />
          ) : null}
        </div>
      </header>

      <MobileConsoleNavigation
        navItems={visibleNavItems}
        isInstanceManager={user?.instanceManager === true}
      />

      <aside aria-label={t`Primary navigation`} {...stylex.props(styles.aside)}>
        <div {...stylex.props(styles.railPin)}>
          <div {...stylex.props(styles.sidebarHead)}>
            <span {...stylex.props(styles.brandRow)}>
              <BrandMark appName={appName} />
            </span>
            <OrganizationMenu
              manageableOrganizations={manageableOrganizations}
              activeOrg={activeOrg}
              disabled={organizationSwitchDisabled}
              onSwitch={(organizationId) => void switchOrganization(organizationId)}
              fullWidth
            />
          </div>
          <div {...stylex.props(styles.navRegion)}>
            <ConsoleNav
              navItems={visibleNavItems}
              isInstanceManager={user?.instanceManager === true}
            />
          </div>
          <div {...stylex.props(styles.railFooter)}>
            <a
              href="https://xid.dev/docs"
              target="_blank"
              rel="noreferrer"
              {...stylex.props(styles.footerLink)}
            >
              <span aria-hidden="true" {...stylex.props(styles.navIcon)}>
                <Icon name="book" size={16} />
              </span>
              <Trans>Documentation</Trans>
              <span aria-hidden="true" {...stylex.props(styles.footerLinkExternal)}>
                <Icon name="arrow-up-right" size={12} />
              </span>
            </a>
            <a href="/account" {...stylex.props(styles.footerLink)}>
              <span aria-hidden="true" {...stylex.props(styles.navIcon)}>
                <Icon name="user-circle" size={16} />
              </span>
              <Trans>Account</Trans>
            </a>
            <div {...stylex.props(styles.footerLanguage)}>
              <LanguageSwitcher />
            </div>
            {status === 'loading' ? (
              <Spinner size={16} />
            ) : user ? (
              <div {...stylex.props(styles.footerUser)}>
                <UserMenu user={user} onSignOut={() => void signOut()} side="top" align="start" />
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <main {...stylex.props(styles.content)}>
        <ActiveAnnouncementsBanner enabled={status === 'authenticated'} />
        {session?.isImpersonation ? (
          <section aria-label={t`Impersonation session`} {...stylex.props(styles.verificationBand)}>
            <div {...stylex.props(styles.verificationNotice)}>
              <div {...stylex.props(styles.verificationMessage)}>
                <Alert tone="warning" title={<Trans>Impersonation session</Trans>}>
                  <Trans>
                    You are viewing this organization as another user. Management changes are
                    disabled.
                  </Trans>
                </Alert>
              </div>
              <Button
                variant="secondary"
                isLoading={endingImpersonation}
                onClick={() => void endImpersonation()}
              >
                <Trans>End impersonation</Trans>
              </Button>
            </div>
          </section>
        ) : null}
        {user && !user.emailVerified && !isGuestUser(user) && !session?.isImpersonation ? (
          <section
            aria-label={t`Email verification required`}
            {...stylex.props(styles.verificationBand)}
          >
            <div {...stylex.props(styles.verificationNotice)}>
              <div {...stylex.props(styles.verificationMessage)}>
                <Alert tone="warning" title={<Trans>Console is read-only</Trans>}>
                  {user.email ? (
                    <Trans>Verify {user.email} before creating or changing resources.</Trans>
                  ) : (
                    <Trans>Verify your email before creating or changing resources.</Trans>
                  )}
                </Alert>
              </div>
              <Button variant="secondary" onClick={openEmailVerification}>
                <Trans>Verify email</Trans>
              </Button>
            </div>
          </section>
        ) : null}
        {isGuestUser(user) && !session?.isImpersonation ? (
          <section aria-label={t`Guest account`} {...stylex.props(styles.verificationBand)}>
            <div {...stylex.props(styles.verificationNotice)}>
              <div {...stylex.props(styles.verificationMessage)}>
                <Alert tone="warning" title={<Trans>Guest account</Trans>}>
                  <Trans>
                    You are signed in as a guest. Set up a sign-in method to keep this account and
                    its data; signing out discards it.
                  </Trans>
                </Alert>
              </div>
              <Button
                variant="secondary"
                onClick={() => window.location.assign('/account/security')}
              >
                <Trans>Set up sign-in method</Trans>
              </Button>
            </div>
          </section>
        ) : null}
        {children}
      </main>
    </div>
  )
}
