// 实例管理员:先选账户所属组织再输入完整邮箱授予(不做建议,不能用来探测账户);
// 列表显示授予人与最后活跃时间,长期未活跃的人在表下提示。不能撤销自己,服务端保证至少保留一人。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useAuth } from '@xid-kit/web-ui/session'
import {
  Alert,
  Badge,
  Button,
  Dropdown,
  EmptyState,
  Field,
  Icon,
  IdentityCell,
  Input,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { page as pageStyles } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { PlatformOrganizationPicker } from '../../components/PlatformOrganizationPicker'
import { PageFrame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { formatRelative } from '../users/user-format'
import {
  useGrantInstanceManager,
  usePlatformManagerAssignments,
  useRevokeInstanceManager,
} from './orgs-users-queries'
import type { PlatformManagerAssignment } from './orgs-users-queries'

const DAY_MS = 86_400_000
const STALE_AFTER_DAYS = 30

const styles = stylex.create({
  grant: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 48rem)': 'minmax(0, 15rem) minmax(0, 17rem) auto',
    },
    alignItems: 'start',
    gap: '0.75rem',
    maxWidth: '45rem',
  },
  grantButton: {
    marginTop: { default: 0, '@media (min-width: 48rem)': '1.625rem' },
  },
  nameRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  stale: {
    color: tokens['--xid-warning'],
  },
})

function managerName(assignment: PlatformManagerAssignment): string {
  return assignment.displayName ?? assignment.email ?? assignment.userId
}

function inactiveDays(assignment: PlatformManagerAssignment, now: number): number | null {
  const since = assignment.lastActiveAt ?? assignment.createdAt
  const days = Math.floor((now - new Date(since).getTime()) / DAY_MS)
  return days >= STALE_AFTER_DAYS ? days : null
}

function GrantedCell({ assignment }: { assignment: PlatformManagerAssignment }): ReactNode {
  const { i18n } = useLingui()
  const grantor = assignment.grantedBy?.displayName ?? assignment.grantedBy?.email ?? null
  return (
    <span {...stylex.props(list.cellStack)}>
      <span>{formatDate(i18n, assignment.createdAt)}</span>
      <span {...stylex.props(list.cellSub)}>
        {assignment.grantedBy === null ? (
          <Trans>At instance setup</Trans>
        ) : grantor ? (
          <Trans>By {grantor}</Trans>
        ) : (
          <Trans>By a former manager</Trans>
        )}
      </span>
    </span>
  )
}

function ActivityLine({
  assignment,
  now,
}: {
  assignment: PlatformManagerAssignment
  now: number
}): ReactNode {
  const { i18n } = useLingui()
  const days = inactiveDays(assignment, now)
  if (days !== null) {
    return (
      <span {...stylex.props(styles.stale)}>
        <Plural value={days} one="Not active for # day" other="Not active for # days" />
      </span>
    )
  }
  if (assignment.grantedBy === null && assignment.lastActiveAt === null) {
    return <Trans>Since instance setup</Trans>
  }
  const relative = formatRelative(i18n, assignment.lastActiveAt, now)
  return relative ? <Trans>Active {relative}</Trans> : <Trans>Not signed in yet</Trans>
}

function useColumns(
  currentUserId: string | undefined,
  canRevoke: boolean,
  onRevoke: (assignment: PlatformManagerAssignment) => void,
): DataTableColumnDef<PlatformManagerAssignment>[] {
  const { t, i18n } = useLingui()
  const now = Date.now()
  return [
    {
      id: 'manager',
      header: () => t`Manager`,
      cell: ({ row }) => {
        const name = managerName(row.original)
        const isSelf = row.original.userId === currentUserId
        return (
          <IdentityCell
            name={
              <span {...stylex.props(styles.nameRow)}>
                {name}
                {isSelf ? (
                  <Badge>
                    <Trans>You</Trans>
                  </Badge>
                ) : null}
              </span>
            }
            secondary={
              <>
                <span {...stylex.props(list.hideNarrow)}>
                  {row.original.email ?? row.original.userId}
                </span>
                <span {...stylex.props(list.onlyNarrow)}>
                  <ActivityLine assignment={row.original} now={now} />
                </span>
              </>
            }
            avatarName={name}
          />
        )
      },
      meta: { priority: 'primary', width: '30%' },
    },
    {
      id: 'organization',
      header: () => t`Account in`,
      cell: ({ row }) => row.original.organizationName ?? row.original.tenantId,
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'granted',
      header: () => t`Granted`,
      cell: ({ row }) => <GrantedCell assignment={row.original} />,
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'last',
      header: () => t`Last active`,
      cell: ({ row }) => {
        const stale = inactiveDays(row.original, now) !== null
        return (
          <span {...stylex.props(list.numeric, stale && styles.stale)}>
            {formatRelative(i18n, row.original.lastActiveAt, now) ?? (
              <span {...stylex.props(list.muted)}>{t`Never`}</span>
            )}
          </span>
        )
      },
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'menu',
      header: () => <span {...stylex.props(pageStyles.visuallyHidden)}>{t`Actions`}</span>,
      cell: ({ row }) => {
        if (row.original.userId === currentUserId || !canRevoke) return null
        const name = managerName(row.original)
        return (
          <span {...stylex.props(list.rowMenu)}>
            <Dropdown
              ariaLabel={t`Actions for ${name}`}
              align="end"
              triggerStyle={list.iconButton}
              trigger={<Icon name="more-horizontal" size={16} />}
              items={[
                {
                  key: 'revoke',
                  label: <Trans>Revoke access…</Trans>,
                  tone: 'danger',
                  onSelect: () => onRevoke(row.original),
                },
              ]}
            />
          </span>
        )
      },
      meta: { priority: 'primary', width: '3rem', align: 'end' },
    },
  ]
}

function GrantForm(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const grant = useGrantInstanceManager()
  const [organizationId, setOrganizationId] = useState('')
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [granted, setGranted] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setSubmitted(true)
    setGranted(null)
    if (!organizationId || !email.includes('@')) return
    grant.mutate(
      { organization_id: organizationId, email: email.trim() },
      {
        onSuccess: (assignment) => {
          setGranted(managerName(assignment))
          setEmail('')
          setSubmitted(false)
        },
      },
    )
  }

  const failure = grant.error
    ? grant.error.code === 'not_found'
      ? t`No active account with that exact email exists in the selected organization.`
      : grant.error.code === 'already_exists'
        ? t`That account is already an instance manager.`
        : grant.error.code === 'forbidden'
          ? t`You cannot grant instance access to yourself.`
          : errorMessage(grant.error, { surface: 'general' })
    : undefined

  return (
    <section {...stylex.props(detail.section)}>
      <h2 {...stylex.props(detail.sectionTitle)}>
        <Trans>Grant instance manager</Trans>
      </h2>
      <form onSubmit={submit} noValidate {...stylex.props(styles.grant)}>
        <PlatformOrganizationPicker
          label={<Trans>Organization</Trans>}
          value={organizationId}
          onChange={setOrganizationId}
          required
          error={
            submitted && !organizationId
              ? t`Select the organization the account belongs to.`
              : undefined
          }
        />
        <Field
          label={<Trans>Email address</Trans>}
          required
          error={submitted && !email.includes('@') ? t`Enter the full email address.` : undefined}
        >
          <Input
            type="email"
            value={email}
            autoComplete="off"
            onChange={(event) => {
              setEmail(event.currentTarget.value)
              grant.reset()
            }}
          />
        </Field>
        <Button type="submit" isLoading={grant.isPending} {...stylex.props(styles.grantButton)}>
          <Trans>Grant access</Trans>
        </Button>
      </form>
      <p {...stylex.props(list.footnote)}>
        <Trans>
          Pick the organization the account belongs to, then type the full address. It must match
          exactly; nothing is suggested, so this form cannot be used to find out who has an account.
        </Trans>
      </p>
      {failure ? <Alert tone="error">{failure}</Alert> : null}
      {granted ? (
        <Alert tone="success">
          <Trans>{granted} is now an instance manager.</Trans>
        </Alert>
      ) : null}
    </section>
  )
}

export default function PlatformInstanceManagers(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const errorMessage = useApiErrorMessage()
  const assignments = usePlatformManagerAssignments()
  const revoke = useRevokeInstanceManager()
  const [pendingRevoke, setPendingRevoke] = useState<PlatformManagerAssignment | null>(null)
  const rows = assignments.data?.data ?? []
  const columns = useColumns(user?.id, rows.length > 1, (assignment) => {
    revoke.reset()
    setPendingRevoke(assignment)
  })
  const now = Date.now()
  const stale = rows.flatMap((assignment) => {
    const days = inactiveDays(assignment, now)
    return days === null || assignment.userId === user?.id ? [] : [{ assignment, days }]
  })

  const revokeError = revoke.error
    ? revoke.error.code === 'conflict'
      ? t`At least one instance manager must remain. The list was refreshed.`
      : errorMessage(revoke.error, { surface: 'general' })
    : undefined
  const revokeName = pendingRevoke ? managerName(pendingRevoke) : ''
  const revokeOrganization = pendingRevoke?.organizationName ?? pendingRevoke?.tenantId ?? ''

  return (
    <PageFrame
      title={<Trans>Instance managers</Trans>}
      lead={
        <Trans>
          People who can manage every organization on this instance. Each one is a normal account
          with an instance-wide manager assignment, not a separate admin login.
        </Trans>
      }
    >
      <GrantForm />
      {assignments.isError && !assignments.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Instance managers could not be loaded</Trans>}
          description={<Trans>Nothing changed. Check your connection and try again.</Trans>}
          action={
            <Button variant="secondary" onClick={() => void assignments.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(assignment) => assignment.id}
            isLoading={assignments.isLoading}
            density="comfortable"
            narrowMode="priority"
            caption={t`Instance managers`}
            captionDisplay="hidden"
            emptyMessage={<Trans>No instance managers found.</Trans>}
          />
          {stale.map(({ assignment, days }) => {
            const name = managerName(assignment)
            return (
              <p key={assignment.id} {...stylex.props(list.footnote)}>
                <Plural
                  value={days}
                  one={`${name} has not signed in for # day. Revoke access you no longer need; it takes effect on their next request.`}
                  other={`${name} has not signed in for # days. Revoke access you no longer need; it takes effect on their next request.`}
                />
              </p>
            )
          })}
        </>
      )}
      {pendingRevoke ? (
        <ConfirmDialog
          title={<Trans>Revoke instance manager access for {revokeName}?</Trans>}
          description={
            <Trans>
              {revokeName} keeps their account in {revokeOrganization} but can no longer manage
              organizations on this instance. It takes effect on their next request.
            </Trans>
          }
          confirmLabel={<Trans>Revoke access</Trans>}
          isLoading={revoke.isPending}
          error={revokeError}
          onConfirm={() =>
            revoke.mutate(pendingRevoke.id, { onSuccess: () => setPendingRevoke(null) })
          }
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </PageFrame>
  )
}
