// 单个 passkey 的卡片:图标、名称与标记(未同步、较早地址)、创建与最近使用时间、重命名与删除入口。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Badge, Dropdown, Icon } from '../../components/ui'
import { AccountIcon } from './account-icons'
import { useAccountDates } from './account-format'
import { surface } from './account-surface'
import { isSecurityKey, passkeyName, passkeyStyles as styles } from './passkey-section-styles'
import type { PasskeyCredential } from './types'

export function PasskeyIcon({ passkey }: { passkey: PasskeyCredential }): ReactNode {
  return (
    <span aria-hidden="true" {...stylex.props(surface.iconTile)}>
      <AccountIcon name={isSecurityKey(passkey) ? 'securityKey' : 'devices'} />
    </span>
  )
}

export function PasskeyMeta({ passkey }: { passkey: PasskeyCredential }): ReactNode {
  const dates = useAccountDates()
  const created = dates.date(passkey.createdAt)
  const lastUsed = passkey.lastUsedAt ? dates.dateTime(passkey.lastUsedAt) : null
  return (
    <>
      <p {...stylex.props(surface.rowMeta)}>
        <Trans>Created {created}</Trans>
      </p>
      <p {...stylex.props(surface.rowMeta)}>
        {lastUsed ? <Trans>Last used {lastUsed}</Trans> : <Trans>Not used yet</Trans>}
      </p>
    </>
  )
}

type CardProps = {
  passkey: PasskeyCredential
  onRename: (passkey: PasskeyCredential) => void
  onRemove: (passkey: PasskeyCredential) => void
}

export function PasskeyCard({ passkey, onRename, onRemove }: CardProps): ReactNode {
  const { t } = useLingui()
  const name = passkeyName(passkey, t`Passkey`)
  return (
    <li {...stylex.props(styles.card)}>
      <PasskeyIcon passkey={passkey} />
      <div {...stylex.props(styles.cardBody)}>
        <div {...stylex.props(surface.rowTitleLine)}>
          <span {...stylex.props(surface.rowTitle)}>{name}</span>
          {passkey.backedUp ? null : (
            <Badge>
              <Trans>Not synced</Trans>
            </Badge>
          )}
          {passkey.earlier ? (
            <Badge>
              <Trans>Earlier address</Trans>
            </Badge>
          ) : null}
        </div>
        <PasskeyMeta passkey={passkey} />
      </div>
      <div {...stylex.props(styles.cardActions)}>
        <button
          type="button"
          aria-label={t`Rename ${name}`}
          onClick={() => onRename(passkey)}
          {...stylex.props(surface.quietButton)}
        >
          <Trans>Rename…</Trans>
        </button>
        <button
          type="button"
          aria-label={t`Remove ${name}`}
          onClick={() => onRemove(passkey)}
          {...stylex.props(surface.quietButton)}
        >
          <Trans>Remove…</Trans>
        </button>
      </div>
      <div {...stylex.props(styles.cardMenu)}>
        <Dropdown
          ariaLabel={t`Actions for ${name}`}
          align="end"
          triggerStyle={styles.menuTrigger}
          trigger={<Icon name="more-horizontal" size={16} />}
          items={[
            { key: 'rename', label: <Trans>Rename…</Trans>, onSelect: () => onRename(passkey) },
            {
              key: 'remove',
              label: <Trans>Remove…</Trans>,
              tone: 'danger',
              onSelect: () => onRemove(passkey),
            },
          ]}
        />
      </div>
    </li>
  )
}
