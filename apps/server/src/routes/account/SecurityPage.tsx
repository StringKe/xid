// /account/security:密码修改 + MFA 因子管理 + Passkey 管理。
// 全宽版式:display 标题区 + 各区块自含 gutter 节(hairline 分节),不使用 page.root 窄容器。
// 各区块状态自包含,此文件仅负责组装与页面框架。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'
import { Alert } from '../../components/ui'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { ChangePasswordSection } from './ChangePasswordSection'
import { MfaSection } from './MfaSection'
import { PasskeySection } from './PasskeySection'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  // 每个区块节:自持 gutter + 底部 hairline
  sectionZone: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
})

export default function SecurityPage(): ReactNode {
  const search = useSearch({ strict: false }) as { setup?: string }
  const showMfaSetupBanner = search.setup === 'mfa'

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Security</Trans>
        </h1>
        {showMfaSetupBanner ? (
          <Alert tone="warning" title={<Trans>Multi-factor authentication required</Trans>}>
            <Trans>
              Your organization requires MFA. Set up an authenticator app below before continuing.
            </Trans>
          </Alert>
        ) : null}
      </div>

      <div {...stylex.props(styles.sectionZone)}>
        <ChangePasswordSection />
      </div>

      <div {...stylex.props(styles.sectionZone)}>
        <MfaSection />
      </div>

      <div {...stylex.props(styles.sectionZone)}>
        <PasskeySection />
      </div>
    </div>
  )
}
