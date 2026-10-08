// 主题选择:与站点页脚同一组选项(System / Light / Dark)和同一键 xid.theme,Console、账户门户、站点同源互通。

import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ChangeEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useTheme } from '../theme'
import { THEME_MODES, isThemeMode, type ThemeMode } from '../theme-preference'
import type { DropdownGroup } from './ui/Dropdown'
import { text, weight } from '../styles/scale.stylex'
import { tokens } from '../styles/tokens.stylex'

const THEME_MODE_LABELS: Record<ThemeMode, MessageDescriptor> = {
  system: msg`System`,
  light: msg`Light`,
  dark: msg`Dark`,
}

const styles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
  },
  label: {
    fontSize: text.sm,
    whiteSpace: 'nowrap',
  },
  select: {
    minHeight: {
      default: '2rem',
      '@media (pointer: coarse)': '2.75rem',
    },
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    paddingBlock: 0,
    paddingInline: '0.625rem',
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${tokens['--xid-accent']}`,
    },
    outlineOffset: '2px',
  },
})

export function ThemeSwitcher(): ReactNode {
  const { t, i18n } = useLingui()
  const { mode, setMode } = useTheme()

  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    if (isThemeMode(event.target.value)) setMode(event.target.value)
  }

  return (
    <label {...stylex.props(styles.root)}>
      <span {...stylex.props(styles.label)}>
        <Trans>Theme</Trans>
      </span>
      <select
        value={mode}
        onChange={handleChange}
        aria-label={t`Theme`}
        data-theme-switcher=""
        {...stylex.props(styles.select)}
      >
        {THEME_MODES.map((item) => (
          <option key={item} value={item}>
            {i18n._(THEME_MODE_LABELS[item])}
          </option>
        ))}
      </select>
    </label>
  )
}

export function useThemeMenuGroup(): DropdownGroup {
  const { t, i18n } = useLingui()
  const { mode, setMode } = useTheme()
  return {
    key: 'theme',
    label: t`Theme`,
    items: THEME_MODES.map((item) => ({
      key: `theme-${item}`,
      label: i18n._(THEME_MODE_LABELS[item]),
      checked: item === mode,
      onSelect: () => setMode(item),
    })),
  }
}
