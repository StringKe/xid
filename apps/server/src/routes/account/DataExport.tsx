// 数据导出行:准备中、可下载(48 小时内)、尚未导出三种状态。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Skeleton } from '../../components/ui'
import { AccountRow, RowMeta } from './AccountPage'
import { useAccountDates } from './account-format'
import { surface } from './account-surface'
import { isExportInProgress, latestExport } from './privacy-shared'
import { useCreatePrivacyRequest, usePrivacyRequestsQuery } from './queries'
import type { PrivacyRequest } from './types'
import { useActionError } from './use-security-action-error'

type ExportState = {
  requests: ReturnType<typeof usePrivacyRequestsQuery>
  latest: PrivacyRequest | null
  ready: PrivacyRequest | null
  preparing: boolean
}

export function useExportState(): ExportState {
  const requests = usePrivacyRequestsQuery()
  const latest = latestExport(requests.data)
  return {
    requests,
    latest,
    ready: latest?.downloadUrl ? latest : null,
    preparing: isExportInProgress(latest),
  }
}

export function ExportBadge(): ReactNode {
  const { ready, preparing } = useExportState()
  if (ready) {
    return (
      <Badge tone="success">
        <Trans>Ready</Trans>
      </Badge>
    )
  }
  if (preparing) {
    return (
      <Badge tone="info">
        <Trans>Preparing</Trans>
      </Badge>
    )
  }
  return null
}

export function DataExportRow(): ReactNode {
  const { t } = useLingui()
  const dates = useAccountDates()
  const { requests, ready, preparing } = useExportState()
  const create = useCreatePrivacyRequest()
  const actionError = useActionError()
  const [error, setError] = useState<string | null>(null)

  const requestExport = async (): Promise<void> => {
    setError(null)
    try {
      await create.mutateAsync({ type: 'export' })
    } catch (err) {
      setError(actionError(err, t`We couldn't start your export. Try again.`))
    }
  }

  if (requests.isPending) {
    return (
      <div {...stylex.props(surface.skeletonStack)}>
        <Skeleton height="2.5rem" />
      </div>
    )
  }
  if (requests.error) {
    return (
      <p {...stylex.props(surface.note)}>
        <Trans>We couldn't load your exports. Refresh the page to try again.</Trans>
      </p>
    )
  }

  const errorNote = error ? (
    <div {...stylex.props(surface.note)}>
      <Alert tone="error">{error}</Alert>
    </div>
  ) : null

  if (ready) {
    const created = dates.date(ready.completedAt ?? ready.createdAt)
    const until = ready.expiresAt ? dates.dateTime(ready.expiresAt) : null
    return (
      <>
        <AccountRow
          title={<Trans>Your export from {created}</Trans>}
          meta={
            until ? (
              <RowMeta>
                <Trans>JSON file. Available until {until}.</Trans>
              </RowMeta>
            ) : null
          }
          actions={
            <>
              <button
                type="button"
                onClick={() => void requestExport()}
                {...stylex.props(surface.quietButton)}
              >
                <Trans>Request new export</Trans>
              </button>
              <Button onClick={() => globalThis.location.assign(ready.downloadUrl ?? '')}>
                <Trans>Download</Trans>
              </Button>
            </>
          }
        />
        {errorNote}
      </>
    )
  }

  return (
    <>
      <AccountRow
        title={
          preparing ? <Trans>We're preparing your export</Trans> : <Trans>No export yet</Trans>
        }
        meta={
          <RowMeta>
            {preparing ? (
              <Trans>
                This usually takes a few minutes. The download is available for 48 hours.
              </Trans>
            ) : (
              <Trans>The download is available for 48 hours after it's ready.</Trans>
            )}
          </RowMeta>
        }
        actions={
          preparing ? null : (
            <Button
              variant="secondary"
              isLoading={create.isPending}
              onClick={() => void requestExport()}
            >
              <Trans>Request export</Trans>
            </Button>
          )
        }
      />
      {errorNote}
    </>
  )
}
