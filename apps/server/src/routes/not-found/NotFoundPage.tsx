// NotFoundPage: 未知 SPA 路径的兜底页(路由 $)。
// 不静默重定向到登录:公开文档 typo 不应被当成未认证。
// 提供回首页与登录的明确出口;文案走 lingui。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Link } from '../../lib/router'
import { LanguageSwitcher } from '../../components/LanguageSwitcher'
import { BrandLogo } from '../../components/BrandLogo'
import { Button } from '../../components/ui'
import { tokens } from '../../styles/tokens.stylex'
import { page } from '../../styles/product-surface.stylex'

const styles = stylex.create({
  main: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1.5rem',
    paddingBlock: '2rem',
    paddingInline: '1.25rem',
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    textAlign: 'center',
  },
  topBar: {
    position: 'absolute',
    top: '1rem',
    right: '1rem',
  },
  code: {
    fontSize: 'clamp(3rem, 12vw, 5rem)',
    fontWeight: 700,
    lineHeight: 1,
    letterSpacing: '-0.03em',
    color: tokens['--xid-muted-foreground'],
    margin: 0,
    fontFamily: tokens['--xid-font-mono'],
  },
  centeredTitle: {
    maxWidth: '28ch',
    textAlign: 'center',
  },
  centeredLead: {
    textAlign: 'center',
    maxWidth: '42ch',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.75rem',
    justifyContent: 'center',
    marginTop: '0.5rem',
  },
  actionLink: {
    textDecoration: 'none',
    color: 'inherit',
  },
})

export default function NotFoundPage(): ReactNode {
  return (
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.topBar)}>
        <LanguageSwitcher />
      </div>

      <BrandLogo variant="mark" height={32} />

      <p {...stylex.props(styles.code)} aria-hidden="true">
        404
      </p>
      <h1 {...stylex.props(page.title, styles.centeredTitle)}>
        <Trans>Page not found</Trans>
      </h1>
      <p {...stylex.props(page.lead, styles.centeredLead)}>
        <Trans>
          This path does not exist on this instance. Check the URL or return to a known page.
        </Trans>
      </p>

      <div {...stylex.props(styles.actions)}>
        <Link to="/" {...stylex.props(styles.actionLink)}>
          <Button variant="primary">
            <Trans>Go to home</Trans>
          </Button>
        </Link>
        <Link to="/sign-in" {...stylex.props(styles.actionLink)}>
          <Button variant="ghost">
            <Trans>Sign in</Trans>
          </Button>
        </Link>
      </div>
    </main>
  )
}
