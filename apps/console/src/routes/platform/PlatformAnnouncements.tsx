import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useCreatePlatformAnnouncement,
  useDeletePlatformAnnouncement,
  usePlatformAnnouncementsQuery,
  useUpdatePlatformAnnouncement,
} from './queries'
import type { PlatformAnnouncement } from './types'

// 持久化 id 形态,非自然语言文案。
const TENANT_ID_EXAMPLE = 'org_...'

const styles = stylex.create({
  form: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '1rem',
  },
  full: {
    gridColumn: '1 / -1',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.625rem',
    alignItems: 'center',
  },
  skeletonStack: {
    display: 'grid',
    gap: '0.75rem',
  },
  list: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 52rem)': 'minmax(0, 7fr) minmax(15rem, 5fr)',
    },
    gap: '1rem',
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  rowTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: '0.9375rem',
    fontWeight: 620,
  },
  body: {
    margin: '0.375rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    alignItems: 'center',
    marginTop: '0.625rem',
  },
  time: {
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
  },
  rowActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: {
      default: 'flex-start',
      '@media (min-width: 52rem)': 'flex-end',
    },
    gap: '0.5rem',
  },
})

type FormState = {
  title: string
  body: string
  scopeType: PlatformAnnouncement['scopeType']
  scopeValue: string
  severity: PlatformAnnouncement['severity']
  status: PlatformAnnouncement['status']
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
    status: 'draft',
    startsAt: new Date().toISOString().slice(0, 16),
    endsAt: '',
  }
}

function statusTone(status: PlatformAnnouncement['status']): 'neutral' | 'success' | 'warning' {
  if (status === 'published') return 'success'
  if (status === 'archived') return 'neutral'
  return 'warning'
}

function statusLabel(status: PlatformAnnouncement['status']): ReactNode {
  if (status === 'published') return <Trans>Published</Trans>
  if (status === 'archived') return <Trans>Archived</Trans>
  return <Trans>Draft</Trans>
}

function severityLabel(severity: PlatformAnnouncement['severity']): ReactNode {
  if (severity === 'critical') return <Trans>Critical</Trans>
  if (severity === 'warning') return <Trans>Warning</Trans>
  if (severity === 'success') return <Trans>Success</Trans>
  return <Trans>Information</Trans>
}

export default function PlatformAnnouncements(): ReactNode {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<string | undefined>()
  const query = usePlatformAnnouncementsQuery(cursor)
  const create = useCreatePlatformAnnouncement()
  const update = useUpdatePlatformAnnouncement()
  const remove = useDeletePlatformAnnouncement()
  const [form, setForm] = useState<FormState>(initialForm)
  const [pendingDelete, setPendingDelete] = useState<PlatformAnnouncement | null>(null)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    create.mutate(
      {
        title: form.title,
        body: form.body,
        scopeType: form.scopeType,
        scopeValue: form.scopeType === 'global' ? null : form.scopeValue,
        severity: form.severity,
        status: form.status,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      },
      { onSuccess: () => setForm(initialForm()) },
    )
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    await remove.mutateAsync({ id: pendingDelete.id })
    setPendingDelete(null)
  }

  return (
    <ConsolePage
      title={<Trans>Announcements</Trans>}
      lead={
        <Trans>
          Publish time-bounded notices globally, to one tenant, or to an accounting plan.
        </Trans>
      }
    >
      {query.isError || create.isError || create.isSuccess || update.isError || remove.isError ? (
        <ConsolePageNotice>
          {query.isError ? (
            <Alert tone="error">
              <Trans>Failed to load announcements.</Trans>
            </Alert>
          ) : null}
          {create.isError ? (
            <Alert tone="error">
              <Trans>Failed to create the announcement. Try again.</Trans>
            </Alert>
          ) : null}
          {create.isSuccess ? (
            <Alert tone="success">
              <Trans>Announcement created.</Trans>
            </Alert>
          ) : null}
          {update.isError ? (
            <Alert tone="error">
              <Trans>Failed to update the announcement. Try again.</Trans>
            </Alert>
          ) : null}
          {remove.isError ? (
            <Alert tone="error">
              <Trans>Failed to delete the announcement. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSplitSection
        title={<Trans>New announcement</Trans>}
        description={
          <Trans>
            Compose the notice, choose its audience, and schedule the publication window.
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
          <Field label={t`Severity`}>
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
              <option value="success">{t`Success`}</option>
              <option value="warning">{t`Warning`}</option>
              <option value="critical">{t`Critical`}</option>
            </Select>
          </Field>
          <div {...stylex.props(styles.full)}>
            <Field label={t`Message`}>
              <Textarea
                required
                maxLength={4000}
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
              />
            </Field>
          </div>
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
              <option value="global">{t`All tenants`}</option>
              <option value="tenant">{t`One tenant`}</option>
              <option value="plan">{t`Accounting plan`}</option>
            </Select>
          </Field>
          {form.scopeType !== 'global' ? (
            <Field label={form.scopeType === 'tenant' ? t`Tenant ID` : t`Plan`}>
              {form.scopeType === 'plan' ? (
                <Select
                  value={form.scopeValue}
                  onChange={(event) => setForm({ ...form, scopeValue: event.target.value })}
                  required
                >
                  <option value="">{t`Select a plan`}</option>
                  <option value="free">{t`Free`}</option>
                  <option value="starter">{t`Starter`}</option>
                  <option value="pro">{t`Pro`}</option>
                  <option value="enterprise">{t`Enterprise`}</option>
                </Select>
              ) : (
                <Input
                  required
                  value={form.scopeValue}
                  onChange={(event) => setForm({ ...form, scopeValue: event.target.value })}
                  placeholder={TENANT_ID_EXAMPLE}
                />
              )}
            </Field>
          ) : null}
          <Field label={t`Starts at`}>
            <Input
              type="datetime-local"
              required
              value={form.startsAt}
              onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
            />
          </Field>
          <Field label={t`Ends at`}>
            <Input
              type="datetime-local"
              value={form.endsAt}
              onChange={(event) => setForm({ ...form, endsAt: event.target.value })}
            />
          </Field>
          <Field label={t`Initial state`}>
            <Select
              value={form.status}
              onChange={(event) =>
                setForm({
                  ...form,
                  status: event.target.value as PlatformAnnouncement['status'],
                })
              }
            >
              <option value="draft">{t`Draft`}</option>
              <option value="published">{t`Published`}</option>
            </Select>
          </Field>
          <div {...stylex.props(styles.actions)}>
            <Button type="submit" isLoading={create.isPending}>
              <Trans>Create announcement</Trans>
            </Button>
          </div>
        </form>
      </ConsolePageSplitSection>

      <ConsolePageSection title={<Trans>Announcement ledger</Trans>}>
        {query.isLoading ? (
          <div {...stylex.props(styles.skeletonStack)}>
            <Skeleton height="6rem" />
            <Skeleton height="6rem" />
            <Skeleton height="6rem" />
          </div>
        ) : null}
        {!query.isLoading && query.data && query.data.data.length === 0 ? (
          <EmptyState title={<Trans>No announcements found.</Trans>} />
        ) : null}
        {query.data && query.data.data.length > 0 ? (
          <>
            <div {...stylex.props(styles.list)}>
              {query.data.data.map((announcement) => (
                <article key={announcement.id} {...stylex.props(styles.row)}>
                  <div>
                    <h3 {...stylex.props(styles.rowTitle)}>{announcement.title}</h3>
                    <p {...stylex.props(styles.body)}>{announcement.body}</p>
                    <div {...stylex.props(styles.meta)}>
                      <Badge tone={statusTone(announcement.status)}>
                        {statusLabel(announcement.status)}
                      </Badge>
                      <Badge tone={announcement.severity === 'critical' ? 'danger' : 'neutral'}>
                        {severityLabel(announcement.severity)}
                      </Badge>
                      <span {...stylex.props(styles.time)}>
                        {new Date(announcement.startsAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div {...stylex.props(styles.rowActions)}>
                    <Button
                      variant="secondary"
                      isLoading={update.isPending && update.variables?.id === announcement.id}
                      onClick={() =>
                        update.mutate({
                          id: announcement.id,
                          body: {
                            status: announcement.status === 'published' ? 'archived' : 'published',
                          },
                        })
                      }
                      {...stylex.props(consoleShell.actionButton)}
                    >
                      {announcement.status === 'published' ? (
                        <Trans>Archive</Trans>
                      ) : (
                        <Trans>Publish</Trans>
                      )}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setPendingDelete(announcement)}
                      aria-label={t`Delete announcement ${announcement.title}`}
                      {...stylex.props(consoleShell.actionButton)}
                    >
                      <Trans>Delete</Trans>
                    </Button>
                  </div>
                </article>
              ))}
            </div>
            <Pagination
              nextCursor={query.data.nextCursor}
              loadMoreLabel={<Trans>Load more</Trans>}
              onLoadMore={setCursor}
            />
          </>
        ) : null}
      </ConsolePageSection>

      {pendingDelete ? (
        <ConfirmDialog
          title={<Trans>Delete announcement?</Trans>}
          description={
            <Trans>The announcement {pendingDelete.title} will be permanently deleted.</Trans>
          }
          confirmLabel={<Trans>Delete</Trans>}
          isLoading={remove.isPending}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
