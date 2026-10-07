// 绑定完成:列出本次添加的方法,主按钮续跑原来的 /authorize 或目标页面。

import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Badge } from '@xid-kit/web-ui/ui/Badge'
import { Button } from '@xid-kit/web-ui/ui/Button'
import { Icon, type IconName } from '@xid-kit/web-ui/ui/Icon'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { tokens } from '../../styles/tokens.stylex'
import type { SetupMethod } from './setup-steps'

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    paddingBlock: '0.875rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  tile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2rem',
    height: '2rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    minWidth: 0,
  },
  title: {
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
  },
  detail: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
})

function AddedRow(props: { icon: IconName; title: ReactNode; detail: ReactNode }): ReactNode {
  return (
    <li {...stylex.props(styles.row)}>
      <span aria-hidden="true" {...stylex.props(styles.tile)}>
        <Icon name={props.icon} size={16} />
      </span>
      <span {...stylex.props(styles.body)}>
        <span {...stylex.props(styles.title)}>{props.title}</span>
        <span {...stylex.props(styles.detail)}>{props.detail}</span>
      </span>
      <Badge tone="success">
        <Trans>Added</Trans>
      </Badge>
    </li>
  )
}

export type SetupSummaryStepProps = {
  method: SetupMethod
  backupCodeCount: number
  organizationName: string | null
  applicationName: string | null
  isContinuing: boolean
  onContinue: () => void
}

export function SetupSummaryStep(props: SetupSummaryStepProps): ReactNode {
  const { t } = useLingui()
  const { organizationName, applicationName, backupCodeCount } = props
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        eyebrow={<Trans>All set</Trans>}
        title={<Trans>Two-step verification is on</Trans>}
        lead={
          organizationName ? (
            <Trans>
              Next time you sign in to {organizationName}, you'll confirm with one of these.
            </Trans>
          ) : (
            <Trans>Next time you sign in, you'll confirm with one of these.</Trans>
          )
        }
      />
      <ul {...stylex.props(styles.list)}>
        {props.method === 'passkey' ? (
          <AddedRow
            icon="passkey"
            title={<Trans>Passkey</Trans>}
            detail={<Trans>Your main second step</Trans>}
          />
        ) : (
          <AddedRow
            icon="smartphone"
            title={<Trans>Authenticator app</Trans>}
            detail={<Trans>Your main second step</Trans>}
          />
        )}
        {backupCodeCount > 0 ? (
          <AddedRow
            icon="file-text"
            title={<Trans>Backup codes</Trans>}
            detail={t`${plural(backupCodeCount, { one: '# code saved', other: '# codes saved' })}`}
          />
        ) : null}
      </ul>
      <div {...stylex.props(hosted.group)}>
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={props.isContinuing}
          onClick={props.onContinue}
        >
          {applicationName ? <Trans>Continue to {applicationName}</Trans> : <Trans>Continue</Trans>}
        </Button>
        <p {...stylex.props(hosted.note)}>
          <Trans>Manage methods any time in your account under Security.</Trans>
        </p>
      </div>
    </div>
  )
}
