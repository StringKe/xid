// ThemeToggle:landing 头部的明暗切换。设计稿 .lp-iconbtn,双态切换
// (system 初始 -> 点击固定 light/dark,经 ThemeProvider setMode)。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { useTheme } from '../../lib/theme'
import { Icon } from './landing-icons'

// .lp-iconbtn:方形细边图标按钮,burger 菜单复用同款。
export const iconButton = stylex.create({
  base: {
    display: 'grid',
    placeItems: 'center',
    // 移动端触控目标 >= 44px;桌面指针环境保持 34px 紧凑尺寸。
    width: { default: '2.125rem', '@media (max-width: 48rem)': '2.75rem' },
    height: { default: '2.125rem', '@media (max-width: 48rem)': '2.75rem' },
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    backgroundColor: {
      default: tokens['--xid-surface'],
      ':hover': tokens['--xid-muted'],
      ':active': `color-mix(in oklch, ${tokens['--xid-muted']} 90%, black)`,
    },
    color: tokens['--xid-fg'],
    cursor: 'pointer',
    // 按压即时反馈:pointer-down 立刻缩小,与 ui/Button 同口径。
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'background-color, transform',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
})

export function ThemeToggle(): ReactNode {
  const { t } = useLingui()
  const { scheme, setMode } = useTheme()
  const isDark = scheme === 'dark'

  return (
    <button
      type="button"
      {...stylex.props(iconButton.base)}
      onClick={() => setMode(isDark ? 'light' : 'dark')}
      aria-label={t`Toggle color theme`}
    >
      <Icon name={isDark ? 'sun' : 'moon'} size={17} />
    </button>
  )
}
