// 入站 SCIM 目录详情:连接信息(SCIM base URL、bearer token 轮换)与同步状态;token 只在创建与轮换时显示一次。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { statusToneFor, useDirectoryStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Badge,
  Button,
  CopyField,
  Dialog,
  Dropdown,
  EmptyState,
  Icon,
  OneTimeSecret,
  Skeleton,
  useCopyToClipboard,
  useToast,
} from '@xid-kit/web-ui/ui'
import { frame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { formatDateTime } from '../../lib/date-format'
import { useDeleteScimDirectory, useOrgScimDirectoriesQuery, useRotateScimToken } from './queries'
import { scimProviderLabel } from './scim-provider-label'
import type { ScimDirectory } from './types'
import { useOrgTarget } from './useOrgTarget'

export type IssuedScimToken = {
  token: string
  previousTokenExpiresAt: string | null
}

const styles = stylex.create({
  layout: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 64rem)': 'minmax(0, 1fr) 22.5rem',
    },
    gap: { default: '1.5rem', '@media (min-width: 64rem)': '2.5rem' },
    alignItems: 'start',
  },
  section: { display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: 0 },
  sectionTitle: {
    margin: 0,
    fontSize: { default: text.md, '@media (min-width: 48rem)': text.lg },
    lineHeight: { default: leading.md, '@media (min-width: 48rem)': leading.lg },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  muted: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.body,
    color: tokens['--xid-muted-foreground'],
  },
  label: { margin: 0, fontSize: text.sm, fontWeight: weight.medium },
  field: { display: 'flex', flexDirection: 'column', gap: '0.375rem' },
  tokenRow: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    flexDirection: 'column',
    gap: '0.375rem',
    alignItems: 'flex-start',
  },
  narrowActions: {
    display: { default: 'grid', '@media (min-width: 48rem)': 'none' },
    gridTemplateColumns: '1fr 1fr',
    gap: '0.5rem',
  },
  narrowSummary: { display: { default: 'block', '@media (min-width: 48rem)': 'none' } },
  aside: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    flexDirection: 'column',
    gap: '0.75rem',
  },
  stats: {
    margin: 0,
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  stat: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.875rem',
    fontSize: text.sm,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: { default: tokens['--xid-border'], ':first-child': 'transparent' },
  },
  statLabel: { color: tokens['--xid-muted-foreground'] },
  statValue: { margin: 0, fontVariantNumeric: 'tabular-nums' },
  lead: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.body,
    color: tokens['--xid-muted-foreground'],
  },
  leadWide: { display: { default: 'none', '@media (min-width: 48rem)': 'block' } },
})

export function ScimTokenDialog({
  issued,
  providerName,
  onDone,
}: {
  issued: IssuedScimToken
  providerName: string
  onDone: () => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const previousUntil = formatDateTime(i18n, issued.previousTokenExpiresAt)
  return (
    <Dialog
      open
      dismissible={false}
      onOpenChange={() => undefined}
      title={<Trans>Copy the bearer token</Trans>}
      description={
        <Trans>
          This is the only time XID shows it. Paste it into {providerName} together with the SCIM
          base URL.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
    >
      <OneTimeSecret
        label={<Trans>Bearer token</Trans>}
        value={issued.token}
        subject={t`bearer token`}
        hint={
          previousUntil ? (
            <Trans>
              The previous token keeps working until {previousUntil}. Update {providerName} before
              then.
            </Trans>
          ) : undefined
        }
        savedLabel={<Trans>I saved the token somewhere safe</Trans>}
        onDone={onDone}
      />
    </Dialog>
  )
}

function SyncStatus({ directory }: { directory: ScimDirectory }): ReactNode {
  const { i18n } = useLingui()
  const lastSync = formatDateTime(i18n, directory.lastSyncAt)
  return (
    <aside {...stylex.props(styles.aside)}>
      <h2 {...stylex.props(detail.attrsTitle)}>
        <Trans>Sync status</Trans>
      </h2>
      <dl {...stylex.props(styles.stats)}>
        <div {...stylex.props(styles.stat)}>
          <dt {...stylex.props(styles.statLabel)}>
            <Trans>Users</Trans>
          </dt>
          <dd {...stylex.props(styles.statValue)}>{i18n.number(directory.userCount)}</dd>
        </div>
        <div {...stylex.props(styles.stat)}>
          <dt {...stylex.props(styles.statLabel)}>
            <Trans>Groups</Trans>
          </dt>
          <dd {...stylex.props(styles.statValue)}>{i18n.number(directory.groupCount)}</dd>
        </div>
        <div {...stylex.props(styles.stat)}>
          <dt {...stylex.props(styles.statLabel)}>
            <Trans>Last sync</Trans>
          </dt>
          <dd {...stylex.props(styles.statValue)}>{lastSync ?? <Trans>Never</Trans>}</dd>
        </div>
      </dl>
    </aside>
  )
}

export default function ScimDirectoryDetail({
  directoryId,
  listPath,
}: {
  directoryId: string
  listPath: string
}): ReactNode {
  const { t, i18n } = useLingui()
  const { notify } = useToast()
  const navigate = useNavigate()
  const errorMessage = useApiErrorMessage()
  const { orgId, orgName } = useOrgTarget()
  const directories = useOrgScimDirectoriesQuery(orgId)
  const rotate = useRotateScimToken(orgId)
  const remove = useDeleteScimDirectory(orgId)
  const statusLabel = useDirectoryStatusLabel()
  const { status: copyStatus, copy } = useCopyToClipboard()
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [issued, setIssued] = useState<IssuedScimToken | null>(null)
  const [deleting, setDeleting] = useState(false)
  const directory = directories.data?.find((row) => row.id === directoryId) ?? null
  const providerName = directory ? scimProviderLabel(i18n, directory.provider) : ''
  const breadcrumb = (
    <ol {...stylex.props(frame.crumbs)}>
      <li>
        <Link to={listPath} {...stylex.props(frame.crumbLink)}>
          <Trans>Directory sync</Trans>
        </Link>
      </li>
      <li aria-hidden="true" {...stylex.props(frame.crumbSep)}>
        /
      </li>
      <li aria-current="page">
        {directory ? providerName : <Skeleton width="6rem" height="0.75rem" />}
      </li>
    </ol>
  )

  if (directories.isError || (directories.data && !directory)) {
    const missing = !directories.isError
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <EmptyState
          variant="load-failure"
          title={
            missing ? (
              <Trans>Directory not found</Trans>
            ) : (
              <Trans>Directory could not be loaded</Trans>
            )
          }
          action={
            missing ? null : (
              <Button variant="secondary" onClick={() => void directories.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            )
          }
        />
      </div>
    )
  }
  if (!directory) {
    return (
      <div {...stylex.props(frame.root)}>
        {breadcrumb}
        <Skeleton width="16rem" height="2rem" />
      </div>
    )
  }

  const lastSync = formatDateTime(i18n, directory.lastSyncAt)
  const users = i18n.number(directory.userCount)
  const groups = i18n.number(directory.groupCount)
  const actionError = rotate.error ?? remove.error

  return (
    <div {...stylex.props(frame.root)}>
      {breadcrumb}
      <div {...stylex.props(detail.header)}>
        <div {...stylex.props(detail.titleBlock)}>
          <div {...stylex.props(detail.titleRow)}>
            <h1 {...stylex.props(detail.title)}>{providerName}</h1>
            <Badge tone={statusToneFor(directory.status)}>{statusLabel(directory.status)}</Badge>
          </div>
          <p {...stylex.props(styles.lead, styles.leadWide)}>
            {lastSync ? (
              <Trans>
                {providerName} pushes users and groups to {orgName} over SCIM 2.0. Last sync{' '}
                {lastSync}.
              </Trans>
            ) : (
              <Trans>
                {providerName} pushes users and groups to {orgName} over SCIM 2.0. Nothing has
                synced yet.
              </Trans>
            )}
          </p>
          <p {...stylex.props(styles.muted, styles.narrowSummary)}>
            {lastSync ? (
              <Trans>
                {users} users and {groups} groups. Last sync {lastSync}.
              </Trans>
            ) : (
              <Trans>
                {users} users and {groups} groups. Nothing has synced yet.
              </Trans>
            )}
          </p>
        </div>
        <Dropdown
          ariaLabel={t`Actions for ${providerName}`}
          align="end"
          triggerStyle={list.filterButton}
          trigger={({ open }) => (
            <>
              <Trans>Actions</Trans>
              <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
            </>
          )}
          items={[
            {
              key: 'rotate',
              label: <Trans>Rotate token…</Trans>,
              onSelect: () => setConfirmRotate(true),
            },
            {
              key: 'delete',
              label: <Trans>Delete directory…</Trans>,
              tone: 'danger' as const,
              separatorBefore: true,
              onSelect: () => setDeleting(true),
            },
          ]}
        />
      </div>
      {actionError ? (
        <Alert tone="error">{errorMessage(actionError, { surface: 'general' })}</Alert>
      ) : null}
      <div {...stylex.props(styles.layout)}>
        <section {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.sectionTitle)}>
            <Trans>Connection</Trans>
          </h2>
          <p {...stylex.props(styles.muted)}>
            <Trans>
              Enter this URL as the SCIM connector base URL in your identity provider, together with
              the directory bearer token.
            </Trans>
          </p>
          <div {...stylex.props(styles.field)}>
            <p {...stylex.props(styles.label)}>
              <Trans>SCIM base URL</Trans>
            </p>
            <CopyField value={directory.scimBaseUrl} subject={t`SCIM base URL`} />
          </div>
          <div {...stylex.props(styles.tokenRow)}>
            <p {...stylex.props(styles.label)}>
              <Trans>Bearer token</Trans>
            </p>
            <Button variant="secondary" onClick={() => setConfirmRotate(true)}>
              <Trans>Rotate token…</Trans>
            </Button>
            <p {...stylex.props(styles.muted)}>
              <Trans>
                The bearer token is shown once, when the directory is created or the token is
                rotated. After a rotation the previous token keeps working for a short overlap, so
                update {providerName} before it ends.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.narrowActions)}>
            <Button variant="secondary" onClick={() => void copy(directory.scimBaseUrl)}>
              {copyStatus === 'copied' ? <Trans>Copied</Trans> : <Trans>Copy URL</Trans>}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmRotate(true)}>
              <Trans>Rotate token…</Trans>
            </Button>
          </div>
        </section>
        <SyncStatus directory={directory} />
      </div>
      {confirmRotate ? (
        <ConfirmDialog
          title={<Trans>Rotate the {providerName} token?</Trans>}
          description={
            <Trans>
              XID issues a new bearer token. The current token keeps working for a short overlap,
              then {providerName} must use the new one.
            </Trans>
          }
          confirmLabel={<Trans>Rotate token</Trans>}
          isLoading={rotate.isPending}
          onConfirm={() =>
            rotate.mutate(directory.id, {
              onSuccess: (result) =>
                setIssued({
                  token: result.scimToken,
                  previousTokenExpiresAt: result.scimTokenPrevExpiresAt,
                }),
              onSettled: () => setConfirmRotate(false),
            })
          }
          onCancel={() => setConfirmRotate(false)}
        />
      ) : null}
      {issued ? (
        <ScimTokenDialog
          issued={issued}
          providerName={providerName}
          onDone={() => setIssued(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={<Trans>Delete the {providerName} directory?</Trans>}
          description={
            <Trans>
              {providerName} stops accepting SCIM requests immediately, including the previous
              token. Users it already provisioned keep their accounts.
            </Trans>
          }
          confirmLabel={<Trans>Delete directory</Trans>}
          isLoading={remove.isPending}
          onConfirm={() =>
            remove.mutate(directory.id, {
              onSuccess: () => {
                notify({ title: t`The ${providerName} directory was deleted` })
                navigate(listPath)
              },
              onSettled: () => setDeleting(false),
            })
          }
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </div>
  )
}
