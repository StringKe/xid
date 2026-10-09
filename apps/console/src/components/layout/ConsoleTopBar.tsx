// 56px 顶栏。≥64rem:命令搜索 + 文档 + 语言 + 账户;48-64rem:Menu 按钮 + 作用域 + 当前分区 + 搜索;
// <48rem:作用域与当前分区两行 + 搜索图标 + 带文字的 Menu 按钮。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { AuthUser } from '@xid-kit/web-ui/session'
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@xid-kit/web-ui/locale'
import { useLocale } from '@xid-kit/web-ui/locale-context'
import { useThemeMenuGroup } from '@xid-kit/web-ui/ThemeSwitcher'
import { Dropdown, Icon, type DropdownEntry } from '@xid-kit/web-ui/ui'
import { trackLocaleChange } from '../../lib/google-analytics-funnel'
import { ScopeSwitcher } from './ScopeSwitcher'
import { initials } from './nav-model'
import { topBar as styles } from './top-bar-styles'

export const DOCS_URL = 'https://xid.dev/docs'

function shortcutLabel(): string {
  const platform = globalThis.navigator?.platform ?? ''
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K'
}

function LanguageMenu(): ReactNode {
  const { t } = useLingui()
  const { locale, setLocale } = useLocale()
  return (
    <Dropdown
      ariaLabel={t`Language`}
      align="end"
      triggerStyle={styles.ghost}
      trigger={
        <>
          <span aria-hidden="true" {...stylex.props(styles.icon)}>
            <Icon name="globe" size={16} />
          </span>
          <span data-locale-menu-trigger="" {...stylex.props(styles.ghostLabel)}>
            {LOCALE_LABELS[locale]}
          </span>
        </>
      }
      items={SUPPORTED_LOCALES.map((candidate) => ({
        key: candidate,
        label: (
          <span lang={candidate} data-locale={candidate}>
            {LOCALE_LABELS[candidate]}
          </span>
        ),
        checked: candidate === locale,
        onSelect: () => {
          if (candidate === locale) return
          trackLocaleChange(locale, candidate)
          void setLocale(candidate)
        },
      }))}
    />
  )
}

export function AccountMenu({
  user,
  onSignOut,
  onEndImpersonation,
  trigger,
  side = 'bottom',
}: {
  user: AuthUser
  onSignOut: () => void
  onEndImpersonation?: () => void
  trigger?: ReactNode
  side?: 'top' | 'bottom'
}): ReactNode {
  const { t } = useLingui()
  const themeGroup = useThemeMenuGroup()
  const items: DropdownEntry[] = onEndImpersonation
    ? [
        ...(themeGroup ? [themeGroup] : []),
        {
          key: 'end-impersonation',
          label: <Trans>End impersonation</Trans>,
          icon: 'sign-out',
          separatorBefore: true,
          onSelect: () => onEndImpersonation(),
        },
      ]
    : [
        {
          key: 'account',
          label: <Trans>Account settings</Trans>,
          icon: 'user-circle',
          href: '/account',
        },
        ...(themeGroup ? [{ ...themeGroup, separatorBefore: true }] : []),
        {
          key: 'sign-out',
          label: <Trans>Sign out</Trans>,
          icon: 'sign-out',
          separatorBefore: true,
          onSelect: () => onSignOut(),
        },
      ]
  return (
    <Dropdown
      ariaLabel={t`Account menu`}
      align="end"
      side={side}
      header={user.email}
      fullWidth={trigger !== undefined}
      triggerStyle={trigger === undefined ? styles.avatarTrigger : styles.identityTrigger}
      trigger={
        trigger ?? (
          <span aria-hidden="true" {...stylex.props(styles.avatar)}>
            {initials(user.name ?? user.email)}
          </span>
        )
      }
      items={items}
    />
  )
}

export type ConsoleTopBarProps = {
  user: AuthUser | null
  sectionLabel: string | null
  scopeDisabled: boolean
  onSwitchOrganization: (organizationId: string) => void
  onOpenSearch: () => void
  onOpenMenu: () => void
  onSignOut: () => void
  onEndImpersonation?: () => void
}

export function ConsoleTopBar(props: ConsoleTopBarProps): ReactNode {
  const { t } = useLingui()
  const shortcut = shortcutLabel()
  return (
    <header {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.start)}>
        <button
          type="button"
          onClick={props.onOpenMenu}
          data-console-menu-trigger=""
          {...stylex.props(styles.menuButton, styles.menuButtonRegular)}
        >
          <Icon name="menu" size={16} />
          <Trans>Menu</Trans>
        </button>
        <div {...stylex.props(styles.context)}>
          <div {...stylex.props(styles.scopeRegular)}>
            <ScopeSwitcher disabled={props.scopeDisabled} onSwitch={props.onSwitchOrganization} />
          </div>
          <div {...stylex.props(styles.scopeNarrow)}>
            <ScopeSwitcher
              compact
              disabled={props.scopeDisabled}
              onSwitch={props.onSwitchOrganization}
            />
          </div>
          {props.sectionLabel ? (
            <span {...stylex.props(styles.section)}>
              <span aria-hidden="true" {...stylex.props(styles.sectionSlash)}>
                /
              </span>
              {props.sectionLabel}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={props.onOpenSearch}
          aria-keyshortcuts="Meta+K Control+K"
          {...stylex.props(styles.search)}
        >
          <Icon name="search" size={16} />
          <span {...stylex.props(styles.searchText)}>
            <span {...stylex.props(styles.searchLong)}>
              <Trans>Search users, apps, or jump to a page</Trans>
            </span>
            <span {...stylex.props(styles.searchShort)}>
              <Trans>Search</Trans>
            </span>
          </span>
          <kbd {...stylex.props(styles.kbd)}>{shortcut}</kbd>
        </button>
      </div>
      <div {...stylex.props(styles.end)}>
        <button
          type="button"
          aria-label={t`Search`}
          onClick={props.onOpenSearch}
          {...stylex.props(styles.iconButton, styles.narrowOnly)}
        >
          <Icon name="search" size={18} />
        </button>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          {...stylex.props(styles.ghost, styles.wideOnly)}
        >
          <span {...stylex.props(styles.ghostLabel)}>
            <Trans>Docs</Trans>
          </span>
        </a>
        <span {...stylex.props(styles.wideOnly)}>
          <LanguageMenu />
        </span>
        {props.user ? (
          <span {...stylex.props(styles.notNarrow)}>
            <AccountMenu
              user={props.user}
              onSignOut={props.onSignOut}
              onEndImpersonation={props.onEndImpersonation}
            />
          </span>
        ) : null}
        <button
          type="button"
          onClick={props.onOpenMenu}
          data-console-menu-trigger=""
          {...stylex.props(styles.menuButton, styles.narrowOnly)}
        >
          <Icon name="menu" size={18} />
          <Trans>Menu</Trans>
        </button>
      </div>
    </header>
  )
}

export { LanguageMenu }
