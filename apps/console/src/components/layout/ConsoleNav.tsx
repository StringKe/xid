// 侧栏导航:sentence case 分组标签不可折叠,激活项是带细线描边的白底块(layoutId 在项间滑动)。
// 只有项目管理委派、没有可管理组织的用户只看到 Applications 分组下被委派的项目。

import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Link, useLocation } from '@xid-kit/web-ui/tanstack-router'
import { motion, springDefault } from '@xid-kit/web-ui/motion'
import type { ConsoleNavItem } from '../../nav'
import { nav as styles } from './shell-styles'
import { navItemActive, navItemTo, navLabelText, segmentNavItems } from './nav-model'

const linkBase = stylex.props(styles.link).className ?? ''
const linkActive = stylex.props(styles.link, styles.linkActive).className ?? ''

function ActiveIndicator(): ReactNode {
  return (
    <motion.span
      aria-hidden="true"
      layoutId="console-nav-rail"
      transition={springDefault}
      {...stylex.props(styles.indicator)}
    />
  )
}

function NavLinkItem({
  item,
  count,
  onNavigate,
}: {
  item: ConsoleNavItem
  count?: number
  onNavigate?: () => void
}): ReactNode {
  const { i18n } = useLingui()
  const location = useLocation()
  const active = navItemActive(location.pathname, item)
  return (
    <li {...stylex.props(styles.item)}>
      {active ? <ActiveIndicator /> : null}
      <Link
        to={navItemTo(item, location.search)}
        className={active ? linkActive : linkBase}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
      >
        <span {...stylex.props(styles.linkText)}>{navLabelText(i18n, item.label)}</span>
        {count !== undefined ? (
          <span {...stylex.props(styles.count, active && styles.countActive)}>
            {i18n.number(count)}
          </span>
        ) : null}
      </Link>
    </li>
  )
}

export type ConsoleNavProps = {
  items: readonly ConsoleNavItem[]
  counts?: Readonly<Record<string, number | undefined>>
  onNavigate?: () => void
  backToConsole?: boolean
}

export function ConsoleNav({
  items,
  counts,
  onNavigate,
  backToConsole,
}: ConsoleNavProps): ReactNode {
  const { t, i18n } = useLingui()
  const segments = segmentNavItems(items)
  return (
    <nav aria-label={t`Primary navigation`} {...stylex.props(styles.groups)}>
      {backToConsole ? (
        <ul {...stylex.props(styles.list)}>
          <NavLinkItem
            item={{ to: '/console', label: msg`Back to console`, end: true }}
            onNavigate={onNavigate}
          />
        </ul>
      ) : null}
      {segments.map((segment, index) => (
        <div key={segment.key ?? `solo-${index}`} {...stylex.props(styles.group)}>
          {segment.label !== null ? (
            <p {...stylex.props(styles.groupLabel)}>{navLabelText(i18n, segment.label)}</p>
          ) : null}
          <ul {...stylex.props(styles.list)}>
            {segment.items.map((item) => (
              <NavLinkItem
                key={item.to}
                item={item}
                count={counts?.[item.to]}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}
