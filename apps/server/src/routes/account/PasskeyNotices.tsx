// Passkeys 区的提示:地址变更后需重新创建、较早地址创建的 passkey、达到数量上限、删除完成。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice } from '../../components/ui'
import { useAccountDates } from './account-format'
import { surface } from './account-surface'
import { passkeyName, passkeyStyles as styles } from './passkey-section-styles'
import type { PasskeyCredential } from './types'

export function ReregistrationNotice({ onDismiss }: { onDismiss: () => void }): ReactNode {
  return (
    <div {...stylex.props(surface.note)}>
      <Notice
        tone="info"
        action={
          <Button variant="ghost" onClick={onDismiss}>
            <Trans>Dismiss</Trans>
          </Button>
        }
      >
        <Trans>
          Passkeys created on a different address don't work here. Create one for this address to
          keep signing in with a passkey.
        </Trans>
      </Notice>
    </div>
  )
}

export function EarlierAddressNotice({
  earlierHost,
  host,
}: {
  earlierHost: string
  host: string
}): ReactNode {
  return (
    <div {...stylex.props(surface.note)}>
      <Notice tone="info">
        <Trans>
          Passkeys marked Earlier address were created on {earlierHost}. They still work here.
          Create a passkey for {host}, then remove the earlier one.
        </Trans>
      </Notice>
    </div>
  )
}

export function PasskeyLimitNotice({
  limit,
  oldest,
}: {
  limit: number
  oldest: PasskeyCredential
}): ReactNode {
  const { t } = useLingui()
  const dates = useAccountDates()
  return (
    <div {...stylex.props(styles.limit)}>
      <p {...stylex.props(styles.limitTitle)}>
        <Trans>You've reached the limit of {limit} passkeys</Trans>
      </p>
      <p {...stylex.props(surface.rowMeta)}>
        <Trans>
          Remove one you no longer use first. {passkeyName(oldest, t`Passkey`)} was last used on{' '}
          {dates.date(oldest.lastUsedAt ?? oldest.createdAt)}.
        </Trans>
      </p>
    </div>
  )
}

export function RemovedNotice({ name }: { name: string }): ReactNode {
  return (
    <div {...stylex.props(surface.note)}>
      <Notice tone="success">
        <Trans>
          {name} was removed. If your password manager still offers it, delete it there too.
        </Trans>
      </Notice>
    </div>
  )
}
