// ConsoleLayout:管理 console(org/instance)全宽外壳。
// 全宽语法:侧栏是贴左缘的全高 rail(brand 驻栏顶,sticky 不随内容滚走),内容列零内边距 --
// 页面各节自持 gutter(clamp(1rem, 2.5vw, 4rem)),1px hairline 是唯一分节语言;
// rail 栏顶 brand 与顶栏同高同底线,横 hairline 在 rail 右缘交点续成一条线。
// Instance Manager 看全局 / Org Admin 看本 org,均复用此壳(见全局铁律 8)。
// nav 项由调用方提供(route agent 据角色填充);用户区取 useAuth,sign-out 走 AuthProvider。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { motion, springDefault } from '@xid-kit/web-ui/motion'
import { useTheme } from '@xid-kit/web-ui/theme'
import { BrandLogo } from '@xid-kit/web-ui/BrandLogo'
import { LanguageSwitcher } from '../LanguageSwitcher'
import { Alert, Button, Spinner } from '@xid-kit/web-ui/ui'

// 单个侧栏导航项(to 为路由路径,label 已本地化)。
// groupKey:稳定字符串键,相邻相同 groupKey 的 item 合并为同一分组(ReactNode 不可用 === 比较)。
// groupLabel:分组可本地化显示文案;undefined groupKey = 无分组(如 Overview 独立项)。
export type ConsoleNavItem = {
  to: string
  label: ReactNode
  // 可选:仅 Instance Manager 可见(route agent 据 activeOrg/permissions 过滤后再传入,此处不做权限判断)。
  end?: boolean
  groupKey?: string
  groupLabel?: ReactNode
}

export type ConsoleLayoutProps = {
  children: ReactNode
  navItems: readonly ConsoleNavItem[]
}

// 内容列水平 gutter:零 padding 壳下页面节与顶栏共用同一口径(全宽规范)。
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
// rail 栏顶 brand 与顶栏同高,两者 borderBottom 在交点续成同一条横线。
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
      '@media (min-width: 48rem)': 'auto 1fr',
    },
    // bg 是页面最底层下沉色;rail 用 sidebar 层,层次靠中性阶 + 1px 边框
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  // 顶栏:只横跨内容列(rail 全高贴左缘),透明底融入内容纸面,1px hairline 收底。
  header: {
    gridColumn: { default: '1', '@media (min-width: 48rem)': '2' },
    gridRow: '1',
    display: 'flex',
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
  // 小屏 brand 驻顶栏左缘;>=48rem 由 rail 栏顶接管(display 互斥,AT 任一宽度只见一份)。
  brandNarrow: {
    display: {
      default: 'inline-flex',
      '@media (min-width: 48rem)': 'none',
    },
    alignItems: 'center',
    gap: '0.5rem',
    fontWeight: 600,
    fontSize: '0.9375rem',
  },
  brandLogo: {
    display: 'inline-flex',
    flexShrink: 0,
  },
  // 当前管理对象(org 名):顶栏左侧上下文;小屏与 brand 间 1px 竖 hairline。
  orgName: {
    fontSize: '0.875rem',
    fontWeight: 550,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
    borderInlineStartWidth: {
      default: '1px',
      '@media (min-width: 48rem)': '0',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    paddingInlineStart: {
      default: '0.75rem',
      '@media (min-width: 48rem)': '0',
    },
  },
  orgSwitcher: {
    minWidth: 'min(16rem, 48vw)',
    maxWidth: '20rem',
    minHeight: '2rem',
    paddingBlock: '0.25rem',
    paddingInline: '0.5rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    fontWeight: 550,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':focus-visible': {
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineOffset: '2px',
      outlineColor: tokens['--xid-primary'],
    },
  },
  userArea: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.5rem 1rem',
    minWidth: 0,
  },
  email: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
  },
  // rail:贴左缘全高第二中性层(bg < sidebar);小屏折叠为顶栏下横向 tab 条。
  aside: {
    gridColumn: '1',
    gridRow: {
      default: '2',
      '@media (min-width: 48rem)': '1 / -1',
    },
    backgroundColor: tokens['--xid-sidebar'],
    borderBottomWidth: {
      default: '1px',
      '@media (min-width: 48rem)': '0',
    },
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    borderInlineEndWidth: {
      default: '0',
      '@media (min-width: 48rem)': '1px',
    },
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
    minWidth: 0,
  },
  // rail 内 sticky 容器:长内容页滚动时导航钉在视口,栏内自滚。
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
    display: 'flex',
    flexDirection: 'column',
  },
  brandRail: {
    display: {
      default: 'none',
      '@media (min-width: 48rem)': 'flex',
    },
    alignItems: 'center',
    gap: '0.5rem',
    minHeight: BAR_MIN_HEIGHT,
    paddingInline: '1.375rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontWeight: 600,
    fontSize: '0.9375rem',
    flexShrink: 0,
  },
  navRegion: {
    padding: {
      default: '0.625rem 1rem',
      '@media (min-width: 48rem)': '1.25rem 0.75rem',
    },
    overflowX: {
      default: 'auto',
      '@media (min-width: 48rem)': 'hidden',
    },
    overflowY: {
      default: 'hidden',
      '@media (min-width: 48rem)': 'auto',
    },
    flexGrow: 1,
  },
  navList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: {
      default: 'row',
      '@media (min-width: 48rem)': 'column',
    },
    flexWrap: {
      default: 'nowrap',
      '@media (min-width: 48rem)': 'wrap',
    },
    gap: {
      default: '0.5rem',
      '@media (min-width: 48rem)': '0.125rem',
    },
  },
  // 导航项:撤实底 pill,激活态 = accent 文字 + motion layoutId 共享指示条(见 ActiveNavIndicator)。
  // 2px 缘线恒占位(透明)防布局跳动,指示条绝对定位叠在缘线位置。
  navLink: {
    display: 'block',
    paddingBlock: '0.4375rem',
    paddingInline: '0.625rem',
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
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 48rem)': '2px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: 'transparent',
    borderBottomWidth: {
      default: '2px',
      '@media (min-width: 48rem)': '0',
    },
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    textDecoration: 'none',
    fontSize: '0.8125rem',
    fontWeight: 450,
    whiteSpace: {
      default: 'nowrap',
      '@media (min-width: 48rem)': 'normal',
    },
    // 文字/底色过渡 150ms(指示条位移走 motion 弹簧,不经 CSS)
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
    borderRadius: tokens['--xid-radius-sm'],
    outlineOffset: '2px',
    outlineColor: tokens['--xid-primary'],
  },
  navLinkActive: {
    color: tokens['--xid-accent'],
    fontWeight: 550,
  },
  navItem: {
    position: 'relative',
  },
  // 激活指示条:rail(竖排左缘)与 tab 条(横排底缘)各一根,CSS 按断点显隐互斥;
  // 位移/变形由 motion layoutId 驱动,样式只描述静态形态。
  navIndicatorRail: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    position: 'absolute',
    insetInlineStart: 0,
    top: 0,
    bottom: 0,
    width: '2px',
    backgroundColor: tokens['--xid-accent'],
    pointerEvents: 'none',
  },
  navIndicatorTab: {
    display: { default: 'block', '@media (min-width: 48rem)': 'none' },
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '2px',
    backgroundColor: tokens['--xid-accent'],
    pointerEvents: 'none',
  },
  // 功能分组标签:mono microlabel;小屏 tab 栏下隐藏。
  // hairline 邻接 >= 1.25rem:配合 navGroupDivider marginBlockStart,label 顶部距 hairline >= 1.25rem
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
  // 分组 hairline 间隔:1px border-top,只在桌面竖排时可见。
  // hairline 邻接 >= 1.25rem:上下文本与 hairline 各保 1.25rem(含 navLink paddingBlock 0.4375rem)
  navGroupDivider: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    marginBlockStart: '0.875rem',
    marginBlockEnd: '0',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  // 内容列:零内边距(全宽规范:边距由页面节自持),零外框感。
  content: {
    gridColumn: { default: '1', '@media (min-width: 48rem)': '2' },
    gridRow: { default: '3', '@media (min-width: 48rem)': '2' },
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
  if (!search.includes('orgId=')) return item.to
  return `${item.to}${search}`
}

function isAccountAlias(path: string): boolean {
  return path === '/console/sessions' || path === '/console/security'
}

// groupKey(string)相同且非 undefined 的相邻 item 合并为一段,取首个 groupLabel 作显示。
// undefined groupKey 的 item 各自独段(无标签)。
type NavSegment = { key: string | null; label: ReactNode; items: readonly ConsoleNavItem[] }

function segmentNavItems(items: readonly ConsoleNavItem[]): readonly NavSegment[] {
  const segments: NavSegment[] = []
  for (const item of items) {
    const last = segments[segments.length - 1]
    if (last && last.key !== null && last.key === item.groupKey) {
      ;(last.items as ConsoleNavItem[]).push(item)
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

// 激活指示条:motion layoutId 共享元素,切换导航时弹簧滑到新激活项(springDefault,
// reduced-motion 下 motion 自动瞬时)。rail 与 tab 条各一个 layoutId 组,跨 ConsoleLayout
// 重挂载(console 路由各自包裹 layout)仍能接续动画。
function ActiveNavIndicator(): ReactNode {
  return (
    <>
      <motion.span
        aria-hidden="true"
        layoutId="console-nav-rail"
        transition={springDefault}
        {...stylex.props(styles.navIndicatorRail)}
      />
      <motion.span
        aria-hidden="true"
        layoutId="console-nav-tab"
        transition={springDefault}
        {...stylex.props(styles.navIndicatorTab)}
      />
    </>
  )
}

function ConsoleNavLi({ item, search }: { item: ConsoleNavItem; search: string }): ReactNode {
  const location = useLocation()
  const active = navItemActive(location.pathname, item)
  const href = navItemTo(item, search)
  return (
    <li {...stylex.props(styles.navItem)}>
      {isAccountAlias(href) ? (
        <a href={href} className={active ? navLinkActive : navLinkBase}>
          {item.label}
        </a>
      ) : (
        <Link to={href} className={active ? navLinkActive : navLinkBase}>
          {item.label}
        </Link>
      )}
      {active ? <ActiveNavIndicator /> : null}
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
  return (
    <nav>
      {segmentNavItems(navItems).map((segment, segIdx) => (
        <div key={segment.key ?? segIdx}>
          {segIdx > 0 && segment.key !== null ? (
            <div aria-hidden="true" {...stylex.props(styles.navGroupDivider)} />
          ) : null}
          {segment.key !== null && segment.label !== null ? (
            <p aria-hidden="true" {...stylex.props(styles.navGroupLabel)}>
              {segment.label}
            </p>
          ) : null}
          <ul {...stylex.props(styles.navList)}>
            {segment.items.map((item) => (
              <ConsoleNavLi key={item.to} item={item} search={location.search} />
            ))}
          </ul>
        </div>
      ))}
      {isInstanceManager ? (
        <div>
          <div aria-hidden="true" {...stylex.props(styles.navGroupDivider)} />
          <p aria-hidden="true" {...stylex.props(styles.navGroupLabel)}>
            <Trans>Platform</Trans>
          </p>
          <ul {...stylex.props(styles.navList)}>
            <ConsoleNavLi
              item={{ to: '/console/platform', label: <Trans>Platform management</Trans> }}
              search={location.search}
            />
          </ul>
        </div>
      ) : null}
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

export function ConsoleLayout({ children, navItems }: ConsoleLayoutProps): ReactNode {
  const { brand } = useTheme()
  const {
    status,
    user,
    activeOrg,
    organizations,
    setActiveOrganization,
    signOut,
    openEmailVerification,
  } = useAuth()
  const { t } = useLingui()
  const navigate = useNavigate()
  const [switchingOrganizationId, setSwitchingOrganizationId] = useState<string | null>(null)
  const appName = brand.appName ?? 'XID'

  async function switchOrganization(organizationId: string): Promise<void> {
    if (!organizationId || organizationId === activeOrg?.id) return
    setSwitchingOrganizationId(organizationId)
    const switched = await setActiveOrganization(organizationId)
    setSwitchingOrganizationId(null)
    if (!switched) return
    navigate(`/console/org?orgId=${encodeURIComponent(organizationId)}`, { replace: true })
  }

  return (
    <div {...stylex.props(styles.shell)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerContext)}>
          <span {...stylex.props(styles.brandNarrow)}>
            <BrandMark appName={appName} />
          </span>
          <select
            aria-label={t`Switch organization`}
            disabled={
              status !== 'authenticated' ||
              organizations.length === 0 ||
              switchingOrganizationId !== null
            }
            onChange={(event) => void switchOrganization(event.currentTarget.value)}
            value={activeOrg?.id ?? ''}
            {...stylex.props(styles.orgSwitcher)}
          >
            {organizations.length === 0 ? (
              <option value="">
                <Trans>No organization selected</Trans>
              </option>
            ) : (
              <>
                {activeOrg ? null : (
                  <option disabled value="">
                    <Trans>Select organization</Trans>
                  </option>
                )}
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organizationDisplayName(organization)}
                  </option>
                ))}
              </>
            )}
          </select>
        </div>

        <div {...stylex.props(styles.userArea)}>
          <LanguageSwitcher />
          {status === 'loading' ? (
            <Spinner size={16} />
          ) : user ? (
            <>
              <span {...stylex.props(styles.email)}>{user.email}</span>
              <Button variant="ghost" onClick={() => void signOut()} aria-label={t`Sign out`}>
                <Trans>Sign out</Trans>
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <aside aria-label={t`Primary navigation`} {...stylex.props(styles.aside)}>
        <div {...stylex.props(styles.railPin)}>
          <span {...stylex.props(styles.brandRail)}>
            <BrandMark appName={appName} />
          </span>
          <div {...stylex.props(styles.navRegion)}>
            <ConsoleNav navItems={navItems} isInstanceManager={user?.instanceManager === true} />
          </div>
        </div>
      </aside>

      <main {...stylex.props(styles.content)}>
        {user && !user.emailVerified ? (
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
        {children}
      </main>
    </div>
  )
}
