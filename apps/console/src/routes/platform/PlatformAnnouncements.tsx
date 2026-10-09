import type { I18n } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { PlatformAnnouncement } from '@xid-kit/types'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Dropdown,
  Field,
  Icon,
  Input,
  Select,
  Textarea,
} from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { AnnouncementBar } from '../../components/ActiveAnnouncementsBanner'
import { PlatformOrganizationPicker } from '../../components/PlatformOrganizationPicker'
import { fromLocalDateTime, nowLocalDateTime } from '../../lib/datetime-local'
import {
  useCreatePlatformAnnouncement,
  useDeletePlatformAnnouncement,
  usePlatformAnnouncementsList,
  usePlatformOrganizationsList,
  useUpdatePlatformAnnouncement,
} from './queries'

const NARROW = '@media (max-width: 40rem)'

type ShownState = 'draft' | 'scheduled' | 'live' | 'ended'

const styles = stylex.create({
  title: {
    display: 'block',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
  },
  body: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '32rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  ended: {
    opacity: 0.7,
  },
  nowrap: {
    whiteSpace: 'nowrap',
  },
  previewTitle: {
    margin: '0 0 0.75rem',
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.display,
  },
  preview: {
    maxWidth: '45rem',
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
  },
  previewPage: {
    paddingBlock: '1rem',
    paddingInline: '1rem',
    color: tokens['--xid-faint-foreground'],
    fontSize: text.xl,
    fontWeight: weight.display,
  },
  form: {
    display: 'grid',
    gap: '1rem',
  },
  twoUp: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr 1fr', [NARROW]: '1fr' },
    gap: '1rem',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
})

function shownState(announcement: PlatformAnnouncement, now: number): ShownState {
  if (announcement.status === 'draft') return 'draft'
  if (announcement.status === 'archived') return 'ended'
  if (new Date(announcement.startsAt).getTime() > now) return 'scheduled'
  if (announcement.endsAt && new Date(announcement.endsAt).getTime() <= now) return 'ended'
  return 'live'
}

const STATE_TONES: Record<ShownState, BadgeTone> = {
  draft: 'neutral',
  scheduled: 'neutral',
  live: 'success',
  ended: 'neutral',
}

function StateBadge({ state }: { state: ShownState }): ReactNode {
  const label =
    state === 'live' ? (
      <Trans>Live</Trans>
    ) : state === 'scheduled' ? (
      <Trans>Scheduled</Trans>
    ) : state === 'ended' ? (
      <Trans>Ended</Trans>
    ) : (
      <Trans>Draft</Trans>
    )
  return <Badge tone={STATE_TONES[state]}>{label}</Badge>
}

function shortDateTime(i18n: I18n, iso: string): string {
  return i18n.date(new Date(iso), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

function ShownWindow({ announcement }: { announcement: PlatformAnnouncement }): ReactNode {
  const { i18n } = useLingui()
  const start = shortDateTime(i18n, announcement.startsAt)
  if (!announcement.endsAt) return <Trans>Since {start}</Trans>
  const end = shortDateTime(i18n, announcement.endsAt)
  return (
    <Trans>
      {start} to {end}
    </Trans>
  )
}

type Actions = {
  onPublish: (announcement: PlatformAnnouncement) => void
  onEnd: (announcement: PlatformAnnouncement) => void
  onDelete: (announcement: PlatformAnnouncement) => void
}

function useAnnouncementColumns(
  organizationNames: Map<string, string>,
  actions: Actions,
): ColumnDef<PlatformAnnouncement>[] {
  const { t } = useLingui()
  return useMemo<ColumnDef<PlatformAnnouncement>[]>(() => {
    const now = Date.now()
    return [
      {
        id: 'announcement',
        header: () => <Trans>Announcement</Trans>,
        cell: ({ row }) => (
          <div {...stylex.props(shownState(row.original, now) === 'ended' && styles.ended)}>
            <span {...stylex.props(styles.title)}>{row.original.title}</span>
            <span {...stylex.props(styles.body)}>{row.original.body}</span>
          </div>
        ),
        meta: { priority: 'primary' },
      },
      {
        id: 'audience',
        header: () => <Trans>Audience</Trans>,
        cell: ({ row }) =>
          row.original.scopeType === 'global' ? (
            <Trans>All organizations</Trans>
          ) : (
            (organizationNames.get(row.original.scopeValue ?? '') ?? row.original.scopeValue)
          ),
        meta: { width: '13rem', priority: 'secondary' },
      },
      {
        id: 'shown',
        header: () => <Trans>Shown</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.nowrap)}>
            <ShownWindow announcement={row.original} />
          </span>
        ),
        meta: { width: '13rem', priority: 'secondary' },
      },
      {
        id: 'status',
        header: () => <Trans>Status</Trans>,
        cell: ({ row }) => <StateBadge state={shownState(row.original, now)} />,
        meta: { width: '7rem' },
      },
      {
        id: 'actions',
        header: () => null,
        cell: ({ row }) => {
          const state = shownState(row.original, now)
          return (
            <Dropdown
              align="end"
              ariaLabel={t`Actions for ${row.original.title}`}
              trigger={<Icon name="more-horizontal" />}
              items={[
                ...(state === 'draft'
                  ? [
                      {
                        key: 'publish',
                        label: t`Publish`,
                        onSelect: () => actions.onPublish(row.original),
                      },
                    ]
                  : []),
                ...(state === 'live' || state === 'scheduled'
                  ? [{ key: 'end', label: t`End now`, onSelect: () => actions.onEnd(row.original) }]
                  : []),
                {
                  key: 'delete',
                  label: t`Delete…`,
                  tone: 'danger' as const,
                  separatorBefore: state !== 'ended',
                  onSelect: () => actions.onDelete(row.original),
                },
              ]}
            />
          )
        },
        meta: { width: '3rem', align: 'end' },
      },
    ]
  }, [t, organizationNames, actions])
}

type FormState = {
  title: string
  body: string
  scopeType: PlatformAnnouncement['scopeType']
  scopeValue: string
  severity: PlatformAnnouncement['severity']
  startsAt: string
  endsAt: string
}

function initialForm(): FormState {
  return {
    title: '',
    body: '',
    scopeType: 'global',
    scopeValue: '',
    severity: 'info',
    startsAt: nowLocalDateTime(),
    endsAt: '',
  }
}

function NewAnnouncementDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const create = useCreatePlatformAnnouncement()
  const [form, setForm] = useState<FormState>(initialForm)

  function save(status: PlatformAnnouncement['status']): void {
    const startsAt = fromLocalDateTime(form.startsAt)
    if (!startsAt) return
    create.mutate(
      {
        title: form.title,
        body: form.body,
        scopeType: form.scopeType,
        scopeValue: form.scopeType === 'global' ? null : form.scopeValue,
        severity: form.severity,
        status,
        startsAt,
        endsAt: fromLocalDateTime(form.endsAt),
      },
      {
        onSuccess: () => {
          setForm(initialForm())
          onOpenChange(false)
        },
      },
    )
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    save('published')
  }

  const missingAudience = form.scopeType === 'tenant' && !form.scopeValue
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={<Trans>New announcement</Trans>}
      description={
        <Trans>
          Shown at the top of the Console to organization admins during the window you set.
        </Trans>
      }
    >
      <form {...stylex.props(styles.form)} onSubmit={submit}>
        <Field label={t`Title`}>
          <Input
            required
            maxLength={160}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
        </Field>
        <Field label={t`Message`}>
          <Textarea
            required
            rows={3}
            maxLength={4000}
            value={form.body}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
          />
        </Field>
        <div {...stylex.props(styles.twoUp)}>
          <Field label={t`Audience`}>
            <Select
              value={form.scopeType}
              onChange={(event) =>
                setForm({
                  ...form,
                  scopeType: event.target.value as PlatformAnnouncement['scopeType'],
                  scopeValue: '',
                })
              }
            >
              <option value="global">{t`All organizations`}</option>
              <option value="tenant">{t`One organization`}</option>
            </Select>
          </Field>
          <Field label={t`Tone`}>
            <Select
              value={form.severity}
              onChange={(event) =>
                setForm({
                  ...form,
                  severity: event.target.value as PlatformAnnouncement['severity'],
                })
              }
            >
              <option value="info">{t`Information`}</option>
              <option value="success">{t`Good news`}</option>
              <option value="warning">{t`Warning`}</option>
              <option value="critical">{t`Critical`}</option>
            </Select>
          </Field>
        </div>
        {form.scopeType === 'tenant' ? (
          <PlatformOrganizationPicker
            label={t`Organization`}
            required
            value={form.scopeValue}
            onChange={(scopeValue) => setForm({ ...form, scopeValue })}
          />
        ) : null}
        <div {...stylex.props(styles.twoUp)}>
          <Field label={t`Show from`}>
            <Input
              type="datetime-local"
              required
              value={form.startsAt}
              onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
            />
          </Field>
          <Field label={t`Show until`} hint={<Trans>Leave empty to show until you end it.</Trans>}>
            <Input
              type="datetime-local"
              value={form.endsAt}
              onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
            />
          </Field>
        </div>
        {form.title ? (
          <div {...stylex.props(styles.preview)}>
            <AnnouncementBar announcement={form} />
          </div>
        ) : null}
        {create.error ? (
          <Alert tone="error">{errorMessage(create.error, { surface: 'general' })}</Alert>
        ) : null}
        <div {...stylex.props(styles.footer)}>
          <Button
            type="button"
            variant="secondary"
            disabled={missingAudience || !form.title || !form.body}
            isLoading={create.isPending && create.variables?.status === 'draft'}
            onClick={() => save('draft')}
          >
            <Trans>Save as draft</Trans>
          </Button>
          <Button
            type="submit"
            disabled={missingAudience}
            isLoading={create.isPending && create.variables?.status === 'published'}
          >
            <Trans>Publish</Trans>
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function LivePreview({ live }: { live: PlatformAnnouncement }): ReactNode {
  return (
    <section aria-labelledby="announcement-preview">
      <h2 id="announcement-preview" {...stylex.props(styles.previewTitle)}>
        <Trans>How organization admins see the live one</Trans>
      </h2>
      <div {...stylex.props(styles.preview)} aria-hidden="true">
        <AnnouncementBar announcement={live} onDismiss={() => undefined} />
        <div {...stylex.props(styles.previewPage)}>
          <Trans>Users</Trans>
        </div>
      </div>
    </section>
  )
}

export default function PlatformAnnouncements(): ReactNode {
  const errorMessage = useApiErrorMessage()
  const announcements = usePlatformAnnouncementsList()
  const organizations = usePlatformOrganizationsList('')
  const update = useUpdatePlatformAnnouncement()
  const remove = useDeletePlatformAnnouncement()
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PlatformAnnouncement | null>(null)
  const rows = announcements.data?.data ?? []
  const organizationNames = useMemo(
    () => new Map((organizations.data?.data ?? []).map((org) => [org.id, org.name])),
    [organizations.data],
  )
  const updateAnnouncement = update.mutate
  const resetRemove = remove.reset
  const actions = useMemo<Actions>(
    () => ({
      onPublish: (announcement) =>
        updateAnnouncement({ id: announcement.id, body: { status: 'published' } }),
      onEnd: (announcement) =>
        updateAnnouncement({ id: announcement.id, body: { status: 'archived' } }),
      onDelete: (announcement) => {
        resetRemove()
        setPendingDelete(announcement)
      },
    }),
    [updateAnnouncement, resetRemove],
  )
  const columns = useAnnouncementColumns(organizationNames, actions)
  const live = rows.find((announcement) => shownState(announcement, Date.now()) === 'live')

  return (
    <ConsolePage
      wide
      title={<Trans>Announcements</Trans>}
      lead={
        <Trans>
          Notices shown at the top of the Console to organization admins. Use them for maintenance
          and changes they need to act on.
        </Trans>
      }
      actions={
        <Button onClick={() => setCreating(true)}>
          <Icon name="plus" />
          <Trans>New announcement</Trans>
        </Button>
      }
    >
      {announcements.isError || update.error ? (
        <ConsolePageNotice>
          {announcements.isError ? (
            <Alert tone="error">
              <Trans>Announcements could not be loaded.</Trans>{' '}
              <Button variant="secondary" onClick={() => void announcements.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            </Alert>
          ) : null}
          {update.error ? (
            <Alert tone="error">{errorMessage(update.error, { surface: 'general' })}</Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={announcements.isLoading}
          emptyMessage={
            <Trans>
              No announcements yet. Post one before maintenance or a change admins act on.
            </Trans>
          }
        />
        <LoadMore query={announcements} loadMoreLabel={<Trans>Load more announcements</Trans>} />
      </ConsolePageSection>

      {live ? (
        <ConsolePageSection>
          <LivePreview live={live} />
        </ConsolePageSection>
      ) : null}

      <NewAnnouncementDialog open={creating} onOpenChange={setCreating} />

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete this announcement?</Trans>}
          description={
            <Trans>
              It disappears from every Console right away. The audit log keeps the record.
            </Trans>
          }
          confirmLabel={<Trans>Delete announcement</Trans>}
          isLoading={remove.isPending}
          error={remove.error ? errorMessage(remove.error, { surface: 'general' }) : undefined}
          onConfirm={() =>
            remove.mutate({ id: pendingDelete.id }, { onSuccess: () => setPendingDelete(null) })
          }
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
