// /account/security:密码修改 + MFA 因子管理 + Passkey 管理。
// 全宽版式:display 标题区 + 各区块自含 gutter 节(hairline 分节),不使用 page.root 窄容器。
// 各区块状态自包含,此文件仅负责组装与页面框架。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'
import { Alert } from '../../components/ui'
import * as stylex from '@stylexjs/stylex'
import { account, consoleShell } from '../../styles/product-surface.stylex'
import { ChangePasswordSection } from './ChangePasswordSection'
import { MfaSection } from './MfaSection'
import { PasskeySection } from './PasskeySection'
import { useAuth } from '../../lib/auth-context'
import { useNavigate } from '../../lib/router'

export default function SecurityPage(): ReactNode {
  const search = useSearch({ strict: false }) as { setup?: string; redirect_to?: string }
  const showMfaSetupBanner = search.setup === 'mfa'
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const redirectTo =
    search.redirect_to?.startsWith('/') && !search.redirect_to.startsWith('//')
      ? search.redirect_to
      : '/console'

  return (
    <div {...stylex.props(account.root)}>
      <div {...stylex.props(consoleShell.headerZone)}>
        <h1 {...stylex.props(consoleShell.displayTitle)}>
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

      <div {...stylex.props(consoleShell.section)}>
        <ChangePasswordSection />
      </div>

      <div {...stylex.props(consoleShell.section)}>
        <MfaSection
          onTotpActivated={
            showMfaSetupBanner
              ? async () => {
                  await refresh()
                  navigate(redirectTo, { replace: true })
                }
              : undefined
          }
        />
      </div>

      <div {...stylex.props(consoleShell.section)}>
        <PasskeySection />
      </div>
    </div>
  )
}
