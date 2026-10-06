import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert } from '@xid-kit/web-ui/ui'

const styles = stylex.create({
  fieldset: {
    borderWidth: 0,
    margin: 0,
    padding: 0,
    minWidth: 0,
  },
})

export function SelfServiceLockNotice(): ReactNode {
  return (
    <Alert tone="info">
      <Trans>
        A platform administrator manages this setting for your organization. You can review it, but
        changes are disabled.
      </Trans>
    </Alert>
  )
}

// 锁定时整组控件原生禁用,服务端 assertOrgSelfServiceEditable 仍是最终门控。
export function LockableFieldset({
  locked,
  children,
}: {
  locked: boolean
  children: ReactNode
}): ReactNode {
  return (
    <fieldset disabled={locked} {...stylex.props(styles.fieldset)}>
      {children}
    </fieldset>
  )
}
