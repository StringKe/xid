// 审计句子共用:加粗的名字与 actor / target 的显示名。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { weight } from '@xid-kit/web-ui/styles/scale.stylex'
import type { AuditEntry } from './overview-queries'
import { scimProviderLabel } from './scim-provider-label'

const styles = stylex.create({
  strong: {
    fontWeight: weight.medium,
  },
})

export function Strong({ children }: { children?: ReactNode }): ReactNode {
  return <span {...stylex.props(styles.strong)}>{children}</span>
}

export function useAuditNames(entry: AuditEntry): { actor: string; target: string } {
  const { t, i18n } = useLingui()
  const raw = entry.actor.displayName ?? entry.actorId ?? ''
  const name = entry.actor.kind === 'directory' ? scimProviderLabel(i18n, raw) : raw
  const actor =
    entry.actor.kind === 'system'
      ? t`XID`
      : entry.actor.kind === 'deleted_user'
        ? t`A deleted user`
        : entry.actor.kind === 'api_key'
          ? t`API key ${name}`
          : entry.actor.kind === 'directory'
            ? t`${name} directory sync`
            : name || t`Someone`
  const target = entry.targetDisplay ?? entry.targetId ?? ''
  return { actor, target }
}
