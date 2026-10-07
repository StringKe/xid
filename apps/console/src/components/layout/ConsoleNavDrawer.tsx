// <64rem 的导航抽屉:头部作用域切换 + 关闭,中间与桌面侧栏同一份导航,底部文档、语言与账户。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { AuthUser } from '@xid-kit/web-ui/session'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { Drawer, DrawerClose, Icon } from '@xid-kit/web-ui/ui'
import { AccountMenu, DOCS_URL, LanguageMenu } from './ConsoleTopBar'
import { ScopeSwitcher } from './ScopeSwitcher'
import { initials } from './nav-model'
import { nav as navStyles } from './shell-styles'

const styles = stylex.create({
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    minHeight: '3.5rem',
    paddingInline: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  scope: {
    flexGrow: 1,
    minWidth: 0,
  },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2.75rem',
    height: '2.75rem',
    borderWidth: 0,
    borderRadius: tokens['--xid-radius'],
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    cursor: 'pointer',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 'calc(100svh - 3.5rem)',
  },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.75rem',
    paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  footerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  docs: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    minHeight: '2.75rem',
    paddingInline: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    textDecoration: 'none',
  },
  avatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2rem',
    height: '2rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    fontSize: text.xs,
    fontWeight: 600,
    color: tokens['--xid-fg'],
  },
  identity: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  identityName: {
    fontSize: text.base,
    lineHeight: leading.sm,
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  identityEmail: {
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: tokens['--xid-muted-foreground'],
    overflowWrap: 'anywhere',
  },
})

export type ConsoleNavDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: AuthUser | null
  scopeDisabled: boolean
  onSwitchOrganization: (organizationId: string) => void
  onSignOut: () => void
  onEndImpersonation?: () => void
  children: ReactNode
}

export function ConsoleNavDrawer(props: ConsoleNavDrawerProps): ReactNode {
  const { t } = useLingui()
  return (
    <Drawer open={props.open} onOpenChange={props.onOpenChange} ariaLabel={t`Primary navigation`}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.scope)}>
          <ScopeSwitcher disabled={props.scopeDisabled} onSwitch={props.onSwitchOrganization} />
        </div>
        <DrawerClose aria-label={t`Close menu`} {...stylex.props(styles.close)}>
          <Icon name="x" size={18} />
        </DrawerClose>
      </div>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(navStyles.region)}>{props.children}</div>
        <div {...stylex.props(styles.footer)}>
          <div {...stylex.props(styles.footerRow)}>
            <a href={DOCS_URL} target="_blank" rel="noreferrer" {...stylex.props(styles.docs)}>
              <Icon name="book" size={16} />
              <Trans>Help and docs</Trans>
            </a>
            <LanguageMenu />
          </div>
          {props.user ? (
            <AccountMenu
              user={props.user}
              side="top"
              onSignOut={props.onSignOut}
              onEndImpersonation={props.onEndImpersonation}
              trigger={
                <>
                  <span aria-hidden="true" {...stylex.props(styles.avatar)}>
                    {initials(props.user.name ?? props.user.email)}
                  </span>
                  <span {...stylex.props(styles.identity)}>
                    <span {...stylex.props(styles.identityName)}>
                      {props.user.name ?? props.user.email}
                    </span>
                    {props.user.name ? (
                      <span {...stylex.props(styles.identityEmail)}>{props.user.email}</span>
                    ) : null}
                  </span>
                </>
              }
            />
          ) : null}
        </div>
      </div>
    </Drawer>
  )
}
