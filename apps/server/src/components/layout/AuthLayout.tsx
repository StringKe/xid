// Hosted Auth 外壳:≥64rem 左侧上下文栏(租户 accent 浅底)+ 右侧任务;48–64rem 顶栏 + 一行上下文 + 卡片;
// <48rem 去掉卡片外框,16px 边距铺满。页面高度用 100svh,主按钮跟在表单后面,不固定在底部。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { BrandMark } from '../hosted/BrandMark'
import { LanguageMenu } from '../hosted/LanguageMenu'
import { useHostedContextCopy, type AuthContextCopy } from '../hosted/context-copy'
import { useHostedAuthConfig } from '../hosted/use-hosted-auth-config'

export type { AuthContextCopy } from '../hosted/context-copy'

export type AuthLayoutProps = {
  children: ReactNode
  footer?: ReactNode
  context?: AuthContextCopy
}

const REGULAR = '@media (min-width: 48rem)'
const SIDEBAR = '@media (min-width: 64rem)'

const styles = stylex.create({
  root: {
    minHeight: '100svh',
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      [SIDEBAR]: 'clamp(22.5rem, 40%, 35rem) minmax(0, 1fr)',
    },
    backgroundColor: {
      default: tokens['--xid-surface'],
      [REGULAR]: tokens['--xid-sidebar'],
      [SIDEBAR]: tokens['--xid-surface'],
    },
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  panel: {
    display: { default: 'none', [SIDEBAR]: 'flex' },
    position: 'sticky',
    top: 0,
    height: '100svh',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: '2.5rem',
    paddingBlock: '3rem',
    paddingInline: 'clamp(2rem, 4vw, 3.5rem)',
    boxSizing: 'border-box',
    backgroundColor: tokens['--xid-accent-wash'],
    overflowY: 'auto',
  },
  contextBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    paddingBottom: '1.5rem',
    maxWidth: '28.75rem',
  },
  contextLead: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: '1.125rem',
  },
  contextTitle: {
    margin: 0,
    fontSize: text.xxl,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-display'],
    lineHeight: 1.1,
    overflowWrap: 'anywhere',
    textWrap: 'balance',
  },
  contextDescription: {
    margin: 0,
    maxWidth: '26.25rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.md,
    lineHeight: 1.55,
  },
  panelFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    paddingTop: '0.5rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  pane: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: '100svh',
    boxSizing: 'border-box',
    paddingInline: {
      default: '1rem',
      [REGULAR]: '1.5rem',
      [SIDEBAR]: 'clamp(2.5rem, 6.7vw, 6rem)',
    },
    paddingBlock: { default: 0, [REGULAR]: '2rem', [SIDEBAR]: '3rem' },
    borderInlineStartWidth: { default: 0, [SIDEBAR]: '1px' },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    backgroundColor: { default: 'transparent', [SIDEBAR]: tokens['--xid-surface'] },
  },
  topBar: {
    display: { default: 'flex', [SIDEBAR]: 'none' },
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    minHeight: '2.75rem',
    paddingBlock: { default: '0.75rem', [REGULAR]: 0 },
  },
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: { default: 'stretch', [REGULAR]: 'center', [SIDEBAR]: 'flex-start' },
    justifyContent: { default: 'flex-start', [REGULAR]: 'center' },
    flexGrow: 1,
    paddingBlock: { default: '0.75rem 1.5rem', [REGULAR]: '2rem' },
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    width: '100%',
    maxWidth: { default: 'none', [REGULAR]: '30rem', [SIDEBAR]: '25rem' },
  },
  contextLine: {
    display: { default: 'block', [SIDEBAR]: 'none' },
    margin: 0,
    paddingBlock: '0.625rem',
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-accent-wash'],
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
    overflowWrap: 'anywhere',
  },
  card: {
    minWidth: 0,
    boxSizing: 'border-box',
    padding: { default: 0, [REGULAR]: '2.5rem', [SIDEBAR]: 0 },
    borderWidth: { default: 0, [REGULAR]: '1px', [SIDEBAR]: 0 },
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: {
      default: 'transparent',
      [REGULAR]: tokens['--xid-surface'],
      [SIDEBAR]: 'transparent',
    },
  },
  footer: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
  },
  bottomBar: {
    display: { default: 'flex', [SIDEBAR]: 'none' },
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: '2.75rem',
    paddingBottom: { default: 'max(0.5rem, env(safe-area-inset-bottom))', [REGULAR]: 0 },
    borderTopWidth: { default: '1px', [REGULAR]: 0 },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
})

function SecuredBy(): ReactNode {
  return <Trans>Secured by XID</Trans>
}

export function AuthLayout({ children, footer, context }: AuthLayoutProps): ReactNode {
  const { config } = useHostedAuthConfig()
  const copy = useHostedContextCopy(context)
  const organizationName = config.context.organizationName
  const host = typeof window === 'undefined' ? undefined : window.location.host

  return (
    <div {...stylex.props(styles.root)}>
      <aside {...stylex.props(styles.panel)}>
        <BrandMark organizationName={organizationName} host={host} />
        <div {...stylex.props(styles.contextBlock)}>
          {copy.lead ? <p {...stylex.props(styles.contextLead)}>{copy.lead}</p> : null}
          <p {...stylex.props(styles.contextTitle)}>{copy.title}</p>
          {copy.description ? (
            <p {...stylex.props(styles.contextDescription)}>{copy.description}</p>
          ) : null}
        </div>
        <div {...stylex.props(styles.panelFooter)}>
          <SecuredBy />
          <LanguageMenu />
        </div>
      </aside>

      <main {...stylex.props(styles.pane)}>
        <header {...stylex.props(styles.topBar)}>
          <BrandMark organizationName={organizationName} compact />
          <LanguageMenu />
        </header>
        <div {...stylex.props(styles.center)}>
          <div {...stylex.props(styles.column)}>
            {copy.line ? <p {...stylex.props(styles.contextLine)}>{copy.line}</p> : null}
            <section {...stylex.props(styles.card)}>{children}</section>
            {footer ? <div {...stylex.props(styles.footer)}>{footer}</div> : null}
          </div>
        </div>
        <footer {...stylex.props(styles.bottomBar)}>
          <SecuredBy />
        </footer>
      </main>
    </div>
  )
}
