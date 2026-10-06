import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'
import { safeInternalPath } from '@xid-kit/web-ui/safe-redirect'
import { Alert } from '../../components/ui'
import * as stylex from '@stylexjs/stylex'
import { account, consoleShell } from '../../styles/product-surface.stylex'
import { ChangePasswordSection } from './ChangePasswordSection'
import { GuestEmailConversionSection } from './GuestEmailConversionSection'
import { MfaSection } from './MfaSection'
import { PasskeySection } from './PasskeySection'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { useDefaultLandingPath } from '../../lib/default-landing'
import { useNavigate } from '../../lib/router'

export default function SecurityPage(): ReactNode {
  const search = useSearch({ strict: false }) as { setup?: string; redirect_to?: string }
  const { refresh, status, user } = useAuth()
  const navigate = useNavigate()
  const defaultLandingPath = useDefaultLandingPath()
  // pending_mfa_setup 只能完成绑定:不挂载只认 active 会话的区块。
  const isForcedSetup = status === 'pending_mfa_setup'
  const showMfaSetupBanner = isForcedSetup || search.setup === 'mfa'
  const resumeAfterSetup = showMfaSetupBanner
    ? async (): Promise<void> => {
        await refresh()
        navigate(safeInternalPath(search.redirect_to, defaultLandingPath), { replace: true })
      }
    : undefined

  return (
    <div {...stylex.props(account.root)}>
      <div {...stylex.props(consoleShell.headerZone)}>
        <h1 {...stylex.props(consoleShell.displayTitle)}>
          <Trans>Security</Trans>
        </h1>
        {showMfaSetupBanner ? (
          <Alert tone="warning" title={<Trans>Multi-factor authentication required</Trans>}>
            <Trans>
              Your organization requires MFA. Set up an authenticator app or a passkey below before
              continuing.
            </Trans>
          </Alert>
        ) : null}
      </div>

      {isGuestUser(user) && !isForcedSetup ? (
        <div {...stylex.props(consoleShell.section)}>
          <GuestEmailConversionSection />
        </div>
      ) : null}

      {isForcedSetup ? null : (
        <div {...stylex.props(consoleShell.section)}>
          <ChangePasswordSection />
        </div>
      )}

      <div {...stylex.props(consoleShell.section)}>
        <MfaSection onTotpActivated={resumeAfterSetup} />
      </div>

      <div {...stylex.props(consoleShell.section)}>
        <PasskeySection onRegistered={resumeAfterSetup} />
      </div>
    </div>
  )
}
