// Apps your organizations sign you in to by filling in a saved username and password (SWA password
// vaulting). Opening an app posts the saved sign-in to that app's sign-in page in a new tab.

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Skeleton } from '../../components/ui'
import { AccountRow, AccountSection, RowMeta } from './AccountPage'
import { surface } from './account-surface'
import { ConfirmDialog } from './ConfirmDialog'
import { SwaCredentialDialog } from './SwaCredentialDialog'
import {
  swaLaunchUrl,
  useRemoveSwaCredential,
  useSwaAppsQuery,
  type SwaApp,
} from './swa-apps-queries'
import { useActionError } from './use-security-action-error'

// 早期服务端把预设的英文默认名存成显示名,按未命名处理,显示应用的主机名。
const PRESET_DEFAULT_NAME = 'SWA password vaulting'

function appDisplayName(app: SwaApp): string {
  const name = app.name?.trim()
  return name && name !== PRESET_DEFAULT_NAME ? name : new URL(app.targetOrigin).host
}

function SwaAppRow({ app }: { app: SwaApp }): ReactNode {
  const { t } = useLingui()
  const remove = useRemoveSwaCredential()
  const actionError = useActionError()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = appDisplayName(app)
  const organization = app.organizationName

  const handleRemove = (): void => {
    setError(null)
    remove.mutate(app.id, {
      onSuccess: () => setConfirming(false),
      onError: (err) => setError(actionError(err, t`We couldn't remove this sign-in. Try again.`)),
    })
  }

  return (
    <>
      <AccountRow
        title={name}
        meta={
          <>
            <RowMeta>{organization}</RowMeta>
            <RowMeta>
              {app.stored && app.username ? (
                <Trans>Signs in as {app.username}</Trans>
              ) : (
                <Trans>No sign-in saved</Trans>
              )}
            </RowMeta>
          </>
        }
        actions={
          app.stored ? (
            <>
              <Button
                variant="secondary"
                aria-label={t`Remove saved sign-in for ${name}`}
                onClick={() => setConfirming(true)}
              >
                <Trans>Remove…</Trans>
              </Button>
              <Button
                variant="secondary"
                aria-label={t`Update saved sign-in for ${name}`}
                onClick={() => setEditing(true)}
              >
                <Trans>Update…</Trans>
              </Button>
              <Button
                variant="accent"
                aria-label={t`Open ${name} in a new tab`}
                onClick={() => globalThis.open(swaLaunchUrl(app.id), '_blank', 'noopener')}
              >
                <Trans>Open</Trans>
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Trans>Save sign-in…</Trans>
            </Button>
          )
        }
      />
      {editing ? (
        <SwaCredentialDialog app={app} appName={name} onClose={() => setEditing(false)} />
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={<Trans>Remove saved sign-in for {name}?</Trans>}
          description={
            <Trans>
              You'll need to enter your username and password again before you can open {name} from
              here.
            </Trans>
          }
          error={error ?? undefined}
          confirmLabel={<Trans>Remove</Trans>}
          confirmVariant="danger"
          isLoading={remove.isPending}
          onConfirm={handleRemove}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  )
}

export function SwaAppsSection(): ReactNode {
  const apps = useSwaAppsQuery()
  const list = apps.data?.data ?? []

  if (!apps.isPending && !apps.error && list.length === 0) return null

  return (
    <AccountSection
      title={<Trans>App sign-ins</Trans>}
      description={
        <Trans>
          Your organization opens these apps by filling in a username and password you save here.
        </Trans>
      }
    >
      {apps.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="2.5rem" />
        </div>
      ) : apps.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your app sign-ins. Refresh the page to try again.</Trans>
        </p>
      ) : (
        list.map((app) => <SwaAppRow key={app.id} app={app} />)
      )}
    </AccountSection>
  )
}
