import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Badge } from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { ScimTarget } from './types'
import { formatDateTime } from '../../lib/date-format'

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  muted: {
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
  },
})

const REASON_MESSAGES: Readonly<Record<string, MessageDescriptor>> = {
  network_failure: msg`The downstream service could not be reached.`,
  token_missing: msg`No downstream API token is configured.`,
  target_configuration_invalid: msg`The target settings are invalid.`,
  target_not_found: msg`The target is no longer available.`,
  tenant_not_found: msg`The target is no longer available.`,
  tenant_issuer_invalid: msg`The target is no longer available.`,
}

const FALLBACK_REASON = msg`The sync failed inside XID.`

export function FailureReason({ code }: { code: string }): ReactNode {
  const { i18n } = useLingui()
  const [reason, status] = code.split(':')
  if (reason === 'downstream_http' && status) {
    return <Trans>The downstream service answered with HTTP {status}.</Trans>
  }
  return <>{i18n._(REASON_MESSAGES[reason ?? ''] ?? FALLBACK_REASON)}</>
}

export function RunBadge({ status }: { status: ScimTarget['lastRunStatus'] }): ReactNode {
  if (status === 'succeeded') {
    return (
      <Badge tone="success">
        <Trans>Succeeded</Trans>
      </Badge>
    )
  }
  if (status === 'retrying') {
    return (
      <Badge tone="warning">
        <Trans>Retrying</Trans>
      </Badge>
    )
  }
  if (status === 'failed') {
    return (
      <Badge tone="danger">
        <Trans>Failed</Trans>
      </Badge>
    )
  }
  return (
    <Badge tone="neutral">
      <Trans>Not run yet</Trans>
    </Badge>
  )
}

// 标题旁的目标状态:按最近一次运行结果描述整个目标。
export function TargetRunBadge({ status }: { status: ScimTarget['lastRunStatus'] }): ReactNode {
  if (status === 'succeeded') {
    return (
      <Badge tone="success">
        <Trans>Last run succeeded</Trans>
      </Badge>
    )
  }
  if (status === 'retrying') {
    return (
      <Badge tone="warning">
        <Trans>Retrying</Trans>
      </Badge>
    )
  }
  if (status === 'failed') {
    return (
      <Badge tone="danger">
        <Trans>Last run failed</Trans>
      </Badge>
    )
  }
  return (
    <Badge tone="neutral">
      <Trans>Not run yet</Trans>
    </Badge>
  )
}

export function ScimTargetRunState({ target }: { target: ScimTarget }): ReactNode {
  const { i18n } = useLingui()
  const runAt = formatDateTime(i18n, target.lastRunAt)
  return (
    <div {...stylex.props(styles.stack)}>
      <RunBadge status={target.lastRunStatus} />
      {target.lastRunError ? (
        <span {...stylex.props(styles.muted)}>
          <FailureReason code={target.lastRunError} />
        </span>
      ) : null}
      {runAt ? <span {...stylex.props(styles.muted)}>{runAt}</span> : null}
    </div>
  )
}
