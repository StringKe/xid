// AuthLayout:Hosted UI(登录/consent/account 入口)的居中卡片布局,认证页视觉锚点。
// brand logo 来自 ThemeProvider 的 brand.logoUrl;无 logo 时回落 appName 文字。
// 布局:单列 grid,垂直自由空间按 0.62:1(黄金比)分配,整列水平居中、视觉重心约 38% 视线高度。
// 层次:bg 上铺极淡品牌细节(accent 4% 顶部晕染 + fg 3% 1px 细网格,均经 color-mix 走 token,
// dark 随 token 翻转),卡片以 surface + 1px 边框立于其上,不靠投影。
// 入场:整列 0.3s opacity + 4px 位移一次入场,prefers-reduced-motion 直接终态。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Stepper } from '@xid-kit/web-ui/ui/Stepper'
import { tokens } from '../../styles/tokens.stylex'
import { useTheme } from '../../lib/theme'
import { LanguageSwitcher } from '../LanguageSwitcher'

export type AuthLayoutProps = {
  children: ReactNode
  footer?: ReactNode
  // 向导步骤指示(mono microlabel),渲染在 topBar brand 与 LanguageSwitcher 之间。
  steps?: {
    current: number
    total: number
    label?: ReactNode
  }
}

const enterRise = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(4px)' },
  to: { opacity: 1, transform: 'translateY(0)' },
})

const GRID_LINE = `color-mix(in oklch, ${tokens['--xid-fg']} 3%, transparent)`

const styles = stylex.create({
  main: {
    minHeight: '100dvh',
    display: 'grid',
    // 黄金比偏上:上下 spacer 按 0.62:1 分自由空间;小视口收到下限后内容自然滚动。
    gridTemplateRows: 'minmax(2.5rem, 0.62fr) auto minmax(2.5rem, 1fr)',
    justifyItems: 'center',
    paddingInline: '1.25rem',
    backgroundColor: tokens['--xid-bg'],
    backgroundImage: `radial-gradient(54rem 38rem at 50% -10rem, color-mix(in oklch, ${tokens['--xid-accent']} 4%, transparent), transparent 72%), linear-gradient(to right, ${GRID_LINE} 1px, transparent 1px), linear-gradient(to bottom, ${GRID_LINE} 1px, transparent 1px)`,
    backgroundSize: 'auto, 2.75rem 2.75rem, 2.75rem 2.75rem',
    fontFamily: tokens['--xid-font'],
  },
  // logo 行 + 卡片 + 页脚同列同宽成组,整列一次入场。
  column: {
    gridRow: 2,
    width: '100%',
    maxWidth: '24rem',
    marginInline: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
    animationName: { default: enterRise, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: '0.3s',
    animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    animationFillMode: 'backwards',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    minHeight: '2rem',
    paddingInline: '0.25rem',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    minWidth: 0,
  },
  logo: {
    height: '1.75rem',
    objectFit: 'contain',
  },
  wordmark: {
    fontSize: '1.0625rem',
    fontWeight: 650,
    letterSpacing: '-0.02em',
    color: tokens['--xid-fg'],
  },
  card: {
    width: '100%',
    boxSizing: 'border-box',
    backgroundColor: tokens['--xid-surface'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    padding: 'clamp(1.5rem, 5vw, 2rem)',
    color: tokens['--xid-fg'],
  },
  footer: {
    marginTop: '0.375rem',
    paddingInline: '0.25rem',
    textAlign: 'center',
    display: 'grid',
    gap: '0.75rem',
    justifyItems: 'center',
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
  },
})

export function AuthLayout({ children, footer, steps }: AuthLayoutProps): ReactNode {
  const { brand } = useTheme()
  const { t } = useLingui()
  const appName = brand.appName ?? 'XID'

  return (
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.topBar)}>
          <div {...stylex.props(styles.header)}>
            {brand.logoUrl ? (
              <img src={brand.logoUrl} alt={t`${appName} logo`} {...stylex.props(styles.logo)} />
            ) : (
              <span {...stylex.props(styles.wordmark)}>{appName}</span>
            )}
          </div>
          {steps ? (
            <Stepper current={steps.current} total={steps.total} label={steps.label} />
          ) : null}
          <LanguageSwitcher />
        </div>

        <section {...stylex.props(styles.card)}>{children}</section>

        {footer ? <footer {...stylex.props(styles.footer)}>{footer}</footer> : null}
      </div>
    </main>
  )
}
