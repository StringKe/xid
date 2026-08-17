// Hosted UI 是一个克制的双栏工作面:品牌上下文在左,当前认证任务在右。
// <64rem 退化为单列,不保留没有任务价值的装饰面板。

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
  steps?: {
    current: number
    total: number
    label?: ReactNode
  }
}

const DESKTOP = '@media (min-width: 64rem)'

const styles = stylex.create({
  main: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: {
      default: '1.25rem',
      [DESKTOP]: '2rem',
    },
    backgroundColor: tokens['--xid-bg'],
    fontFamily: tokens['--xid-font'],
  },
  // 桌面是一个连续工作面,边界只出现一次。
  panel: {
    width: '100%',
    maxWidth: {
      default: '26rem',
      [DESKTOP]: '60rem',
    },
    marginInline: 'auto',
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      [DESKTOP]: 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    backgroundColor: tokens['--xid-surface'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    overflow: 'hidden',
  },
  brandPanel: {
    display: {
      default: 'none',
      [DESKTOP]: 'flex',
    },
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: '2.5rem',
    padding: 'clamp(2rem, 3vw, 2.75rem)',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-sidebar'],
  },
  brandHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    minWidth: 0,
  },
  brandBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    paddingTop: '1.5rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  brandStatement: {
    margin: 0,
    fontSize: 'clamp(1.5rem, 2vw, 1.875rem)',
    fontWeight: 620,
    letterSpacing: '-0.03em',
    lineHeight: 1.18,
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  formPane: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    padding: {
      default: '1.25rem',
      [DESKTOP]: 'clamp(1.75rem, 3vw, 2.75rem)',
    },
    minHeight: { default: 'auto', [DESKTOP]: '38rem' },
  },
  // 桌面端顶行:Stepper 靠左,LanguageSwitcher 右对齐,贴着表单窗格边缘。
  desktopBar: {
    display: {
      default: 'none',
      [DESKTOP]: 'flex',
    },
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.75rem',
    minHeight: '2rem',
    paddingBlockEnd: '0.5rem',
  },
  desktopBarSteps: {
    marginRight: 'auto',
  },
  column: {
    width: '100%',
    maxWidth: {
      default: 'none',
      [DESKTOP]: '26rem',
    },
    // 占据表单窗格剩余空间并居中,内容超高时 margin 折叠回归正常滚动。
    marginBlock: 'auto',
    marginInline: {
      default: 0,
      [DESKTOP]: 'auto',
    },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
  },
  // 移动端顶行沿用原 topBar 行为:logo 左、Stepper 中、LanguageSwitcher 右。
  mobileBar: {
    display: {
      default: 'flex',
      [DESKTOP]: 'none',
    },
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    minHeight: '2rem',
    paddingInline: '0.25rem',
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
  // panel 已提供唯一容器边界,表单本身不再叠一层卡片。
  card: {
    width: '100%',
    boxSizing: 'border-box',
    backgroundColor: 'transparent',
    padding: { default: '1rem 0.25rem', [DESKTOP]: '0.5rem' },
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
  const logo = brand.logoUrl ? (
    <img src={brand.logoUrl} alt={t`${appName} logo`} {...stylex.props(styles.logo)} />
  ) : (
    <span {...stylex.props(styles.wordmark)}>{appName}</span>
  )

  return (
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.panel)}>
        <aside {...stylex.props(styles.brandPanel)}>
          <div {...stylex.props(styles.brandHeader)}>{logo}</div>

          <div {...stylex.props(styles.brandBody)}>
            <p {...stylex.props(styles.brandStatement)}>
              {t`One ${appName} account. Every application.`}
            </p>
          </div>
        </aside>

        <div {...stylex.props(styles.formPane)}>
          <div {...stylex.props(styles.desktopBar)}>
            {steps ? (
              <div {...stylex.props(styles.desktopBarSteps)}>
                <Stepper current={steps.current} total={steps.total} label={steps.label} />
              </div>
            ) : null}
            <LanguageSwitcher />
          </div>

          <div {...stylex.props(styles.column)}>
            <div {...stylex.props(styles.mobileBar)}>
              <div {...stylex.props(styles.brandHeader)}>{logo}</div>
              {steps ? (
                <Stepper current={steps.current} total={steps.total} label={steps.label} />
              ) : null}
              <LanguageSwitcher />
            </div>

            <section {...stylex.props(styles.card)}>{children}</section>

            {footer ? <footer {...stylex.props(styles.footer)}>{footer}</footer> : null}
          </div>
        </div>
      </div>
    </main>
  )
}
