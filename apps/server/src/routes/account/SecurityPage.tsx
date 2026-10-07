import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { account, consoleShell } from '../../styles/product-surface.stylex'
import { ChangePasswordSection } from './ChangePasswordSection'
import { GuestEmailConversionSection } from './GuestEmailConversionSection'
import { MfaSection } from './MfaSection'
import { PasskeySection } from './PasskeySection'
import { isGuestUser, useAuth } from '../../lib/auth-context'

export default function SecurityPage(): ReactNode {
  const { user } = useAuth()

  return (
    <div {...stylex.props(account.root)}>
      <div {...stylex.props(consoleShell.headerZone)}>
        <h1 {...stylex.props(consoleShell.displayTitle)}>
          <Trans>Security</Trans>
        </h1>
      </div>

      {isGuestUser(user) ? (
        <div {...stylex.props(consoleShell.section)}>
          <GuestEmailConversionSection />
        </div>
      ) : null}

      <div {...stylex.props(consoleShell.section)}>
        <ChangePasswordSection />
      </div>

      <div {...stylex.props(consoleShell.section)}>
        <MfaSection />
      </div>

      <div {...stylex.props(consoleShell.section)}>
        <PasskeySection />
      </div>
    </div>
  )
}
