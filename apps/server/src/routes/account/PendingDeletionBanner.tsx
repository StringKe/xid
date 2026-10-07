// 账号已排期删除时,整个账户门户顶部常驻横幅:写明删除日期,并能直接取消。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { Button } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { tokens } from '../../styles/tokens.stylex'
import { useAccountDates } from './account-format'
import { useCancelPrivacyRequest, usePrivacyRequestsQuery } from './queries'
import type { PrivacyRequest } from './types'
import { useActionError } from './use-security-action-error'

const styles = stylex.create({
  band: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 48rem)': 'row' },
    alignItems: { default: 'stretch', '@media (min-width: 48rem)': 'center' },
    justifyContent: 'space-between',
    gap: '0.75rem 1.5rem',
    paddingBlock: '0.875rem',
    paddingInlineStart: {
      default: '1rem',
      '@media (min-width: 48rem)': '2.5rem',
      '@media (min-width: 64rem)': '4rem',
    },
    paddingInlineEnd: { default: '1rem', '@media (min-width: 48rem)': '1.5rem' },
    backgroundColor: tokens['--xid-danger-bg'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  body: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: tokens['--xid-muted-foreground'],
  },
  error: {
    margin: 0,
    fontSize: text.sm,
    color: tokens['--xid-danger'],
  },
})

export function scheduledDeletion(
  requests: readonly PrivacyRequest[] | undefined,
): PrivacyRequest | null {
  return (
    requests?.find((request) => request.type === 'delete' && request.status === 'pending') ?? null
  )
}

export function PendingDeletionBanner(): ReactNode {
  const { user } = useAuth()
  if (!user || isGuestUser(user)) return null
  return <PendingDeletionNotice />
}

function PendingDeletionNotice(): ReactNode {
  const { t } = useLingui()
  const dates = useAccountDates()
  const requests = usePrivacyRequestsQuery()
  const cancel = useCancelPrivacyRequest()
  const actionError = useActionError()
  const [error, setError] = useState<string | null>(null)
  const pending = scheduledDeletion(requests.data)
  if (!pending?.scheduledFor) return null

  const deletionDate = dates.date(pending.scheduledFor)
  const requestedDate = dates.date(pending.createdAt)

  const handleCancel = async (): Promise<void> => {
    setError(null)
    try {
      await cancel.mutateAsync(pending.id)
    } catch (err) {
      setError(actionError(err, t`We couldn't cancel the deletion. Try again.`))
    }
  }

  return (
    <section aria-label={t`Account deletion`} {...stylex.props(styles.band)}>
      <div {...stylex.props(styles.text)}>
        <p {...stylex.props(styles.title)}>
          <Trans>Your account will be deleted on {deletionDate}</Trans>
        </p>
        <p {...stylex.props(styles.body)}>
          <Trans>
            You scheduled this on {requestedDate}. Until then, everything keeps working and you can
            change your mind.
          </Trans>
        </p>
        {error ? <p {...stylex.props(styles.error)}>{error}</p> : null}
      </div>
      <Button isLoading={cancel.isPending} onClick={() => void handleCancel()}>
        <Trans>Cancel deletion</Trans>
      </Button>
    </section>
  )
}
