import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Alert, Badge, Button, EmptyState, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useCreatePlatformAnnouncement,
  useDeletePlatformAnnouncement,
  usePlatformAnnouncementsQuery,
  useUpdatePlatformAnnouncement,
} from './queries'
import type { PlatformAnnouncement } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
// This is a persisted identifier shape rather than natural-language copy.
const TENANT_ID_EXAMPLE = 'org_...'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  header: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
  },
  lead: {
    maxWidth: '52rem',
    margin: '0.5rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
    lineHeight: 1.55,
  },
  section: {
    paddingInline: GUTTER,
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  sectionTitle: {
    margin: '0 0 1rem',
    color: tokens['--xid-fg'],
    fontSize: '1rem',
    fontWeight: 620,
  },
  form: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: '1rem',
    maxWidth: '58rem',
  },
  full: {
    gridColumn: '1 / -1',
  },
  select: {
    width: '100%',
    minHeight: '2.625rem',
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.9375rem',
  },
  textarea: {
    width: '100%',
    minHeight: '7rem',
    resize: 'vertical',
    padding: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.9375rem',
    lineHeight: 1.5,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.625rem',
    alignItems: 'center',
  },
  message: {
    marginBottom: '1rem',
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

  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Announcements</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Publish time-bounded notices globally, to one tenant, or to an accounting plan.
          </Trans>
        </p>
      </header>

      <section aria-labelledby="announcement-create" {...stylex.props(styles.section)}>
        <h2 id="announcement-create" {...stylex.props(styles.sectionTitle)}>
          <Trans>New announcement</Trans>
        </h2>
        {create.isError ? (
          <div {...stylex.props(styles.message)}>
            <Alert tone="error">{create.error.message}</Alert>
          </div>
        ) : null}
        {create.isSuccess ? (
          <div {...stylex.props(styles.message)}>
            <Alert tone="success">
              <Trans>Announcement created.</Trans>
            </Alert>
          </div>
        ) : null}
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
            <select
              {...stylex.props(styles.select)}
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
            </select>
          </Field>
          <div {...stylex.props(styles.full)}>
            <Field label={t`Message`}>
              <textarea
                {...stylex.props(styles.textarea)}
                required
                maxLength={4000}
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
              />
            </Field>
          </div>
          <Field label={t`Audience`}>
            <select
              {...stylex.props(styles.select)}
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
            </select>
          </Field>
          {form.scopeType !== 'global' ? (
            <Field label={form.scopeType === 'tenant' ? t`Tenant ID` : t`Plan`}>
              {form.scopeType === 'plan' ? (
                <select
                  {...stylex.props(styles.select)}
                  value={form.scopeValue}
                  onChange={(event) => setForm({ ...form, scopeValue: event.target.value })}
                  required
                >
                  <option value="">{t`Select a plan`}</option>
                  <option value="free">{t`Free`}</option>
                  <option value="starter">{t`Starter`}</option>
                  <option value="pro">{t`Pro`}</option>
                  <option value="enterprise">{t`Enterprise`}</option>
                </select>
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
            <select
              {...stylex.props(styles.select)}
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
            </select>
          </Field>
          <div {...stylex.props(styles.actions)}>
            <Button type="submit" isLoading={create.isPending}>
              <Trans>Create announcement</Trans>
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="announcement-list" {...stylex.props(styles.section)}>
        <h2 id="announcement-list" {...stylex.props(styles.sectionTitle)}>
          <Trans>Announcement ledger</Trans>
        </h2>
        {query.isLoading ? (
          <Spinner />
        ) : query.isError ? (
          <Alert tone="error">
            <Trans>Failed to load announcements.</Trans>
          </Alert>
        ) : !query.data?.data.length ? (
          <EmptyState title={<Trans>No announcements found.</Trans>} />
        ) : (
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
                    >
                      {announcement.status === 'published' ? (
                        <Trans>Archive</Trans>
                      ) : (
                        <Trans>Publish</Trans>
                      )}
                    </Button>
                    <Button
                      variant="secondary"
                      isLoading={remove.isPending && remove.variables?.id === announcement.id}
                      onClick={() => {
                        if (window.confirm(t`Delete announcement "${announcement.title}"?`)) {
                          remove.mutate({ id: announcement.id })
                        }
                      }}
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
        )}
      </section>
    </div>
  )
}
