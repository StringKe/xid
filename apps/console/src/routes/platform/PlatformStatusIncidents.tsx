import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Alert, Badge, Button, EmptyState, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useAppendStatusIncidentUpdate,
  useCreateStatusIncident,
  useDeleteStatusIncident,
  usePlatformStatusIncidentsQuery,
} from './queries'
import type { StatusIncident } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

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
    minHeight: '6rem',
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
  message: {
    marginBottom: '1rem',
  },
  list: {
    display: 'grid',
    gap: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  incident: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 56rem)': 'minmax(0, 7fr) minmax(17rem, 5fr)',
    },
    gap: '1.25rem',
    paddingBlock: '1.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  incidentTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: '1rem',
    fontWeight: 620,
  },
  summary: {
    margin: '0.375rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.8125rem',
    lineHeight: 1.55,
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    alignItems: 'center',
    marginTop: '0.75rem',
  },
  time: {
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
  },
  timeline: {
    margin: '1rem 0 0',
    padding: 0,
    listStyle: 'none',
  },
  timelineItem: {
    display: 'grid',
    gridTemplateColumns: '7.5rem 1fr',
    gap: '0.75rem',
    paddingBlock: '0.5rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.75rem',
    lineHeight: 1.45,
  },
  updateForm: {
    display: 'grid',
    gap: '0.75rem',
    alignContent: 'start',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
})

function statusLabel(status: StatusIncident['status']): ReactNode {
  if (status === 'investigating') return <Trans>Investigating</Trans>
  if (status === 'identified') return <Trans>Identified</Trans>
  if (status === 'monitoring') return <Trans>Monitoring</Trans>
  return <Trans>Resolved</Trans>
}

function impactLabel(impact: StatusIncident['impact']): ReactNode {
  if (impact === 'critical') return <Trans>Critical impact</Trans>
  if (impact === 'major') return <Trans>Major impact</Trans>
  if (impact === 'minor') return <Trans>Minor impact</Trans>
  return <Trans>No impact</Trans>
}

function incidentTone(incident: StatusIncident): 'neutral' | 'success' | 'warning' | 'danger' {
  if (incident.status === 'resolved') return 'success'
  if (incident.impact === 'critical' || incident.impact === 'major') return 'danger'
  if (incident.impact === 'minor') return 'warning'
  return 'neutral'
}

function IncidentItem({ incident }: { incident: StatusIncident }): ReactNode {
  const { t } = useLingui()
  const append = useAppendStatusIncidentUpdate()
  const remove = useDeleteStatusIncident()
  const [status, setStatus] = useState<StatusIncident['status']>(incident.status)
  const [message, setMessage] = useState('')

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    append.mutate({ id: incident.id, status, message }, { onSuccess: () => setMessage('') })
  }

  return (
    <article {...stylex.props(styles.incident)}>
      <div>
        <h3 {...stylex.props(styles.incidentTitle)}>{incident.title}</h3>
        <p {...stylex.props(styles.summary)}>{incident.summary}</p>
        <div {...stylex.props(styles.meta)}>
          <Badge tone={incidentTone(incident)}>{statusLabel(incident.status)}</Badge>
          <Badge tone={incident.impact === 'critical' ? 'danger' : 'neutral'}>
            {impactLabel(incident.impact)}
          </Badge>
          <span {...stylex.props(styles.time)}>
            {new Date(incident.startedAt).toLocaleString()}
          </span>
        </div>
        {incident.updates.length ? (
          <ol {...stylex.props(styles.timeline)}>
            {incident.updates.map((update) => (
              <li key={update.id} {...stylex.props(styles.timelineItem)}>
                <time dateTime={update.createdAt}>
                  {new Date(update.createdAt).toLocaleString()}
                </time>
                <span>
                  {statusLabel(update.status)}: {update.message}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <form {...stylex.props(styles.updateForm)} onSubmit={submit}>
        {append.isError ? <Alert tone="error">{append.error.message}</Alert> : null}
        <Field label={t`Next status`}>
          <select
            {...stylex.props(styles.select)}
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusIncident['status'])}
          >
            <option value="investigating">{t`Investigating`}</option>
            <option value="identified">{t`Identified`}</option>
            <option value="monitoring">{t`Monitoring`}</option>
            <option value="resolved">{t`Resolved`}</option>
          </select>
        </Field>
        <Field label={t`Public update`}>
          <textarea
            {...stylex.props(styles.textarea)}
            required
            maxLength={4000}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
        <div {...stylex.props(styles.actions)}>
          <Button type="submit" isLoading={append.isPending}>
            <Trans>Publish update</Trans>
          </Button>
          <Button
            type="button"
            variant="secondary"
            isLoading={remove.isPending}
            onClick={() => {
              if (window.confirm(t`Delete incident "${incident.title}" and its updates?`)) {
                remove.mutate({ id: incident.id })
              }
            }}
          >
            <Trans>Delete</Trans>
          </Button>
        </div>
      </form>
    </article>
  )
}

export default function PlatformStatusIncidents(): ReactNode {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<string | undefined>()
  const query = usePlatformStatusIncidentsQuery(cursor)
  const create = useCreateStatusIncident()
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [impact, setImpact] = useState<StatusIncident['impact']>('minor')
  const [startedAt, setStartedAt] = useState(new Date().toISOString().slice(0, 16))

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    create.mutate(
      {
        title,
        summary,
        impact,
        status: 'investigating',
        startedAt: new Date(startedAt).toISOString(),
      },
      {
        onSuccess: () => {
          setTitle('')
          setSummary('')
          setImpact('minor')
        },
      },
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Status incidents</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Keep the public status page current with incident impact, state, and timestamped
            updates.
          </Trans>
        </p>
      </header>

      <section aria-labelledby="incident-create" {...stylex.props(styles.section)}>
        <h2 id="incident-create" {...stylex.props(styles.sectionTitle)}>
          <Trans>Open incident</Trans>
        </h2>
        {create.isError ? (
          <div {...stylex.props(styles.message)}>
            <Alert tone="error">{create.error.message}</Alert>
          </div>
        ) : null}
        <form {...stylex.props(styles.form)} onSubmit={submit}>
          <Field label={t`Incident title`}>
            <Input
              required
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={t`Impact`}>
            <select
              {...stylex.props(styles.select)}
              value={impact}
              onChange={(event) => setImpact(event.target.value as StatusIncident['impact'])}
            >
              <option value="none">{t`None`}</option>
              <option value="minor">{t`Minor`}</option>
              <option value="major">{t`Major`}</option>
              <option value="critical">{t`Critical`}</option>
            </select>
          </Field>
          <div {...stylex.props(styles.full)}>
            <Field label={t`Public summary`}>
              <textarea
                {...stylex.props(styles.textarea)}
                required
                maxLength={4000}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </Field>
          </div>
          <Field label={t`Started at`}>
            <Input
              type="datetime-local"
              required
              value={startedAt}
              onChange={(event) => setStartedAt(event.target.value)}
            />
          </Field>
          <div {...stylex.props(styles.actions)}>
            <Button type="submit" isLoading={create.isPending}>
              <Trans>Open incident</Trans>
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="incident-ledger" {...stylex.props(styles.section)}>
        <h2 id="incident-ledger" {...stylex.props(styles.sectionTitle)}>
          <Trans>Incident ledger</Trans>
        </h2>
        {query.isLoading ? (
          <Spinner />
        ) : query.isError ? (
          <Alert tone="error">
            <Trans>Failed to load status incidents.</Trans>
          </Alert>
        ) : !query.data?.data.length ? (
          <EmptyState title={<Trans>No incidents have been reported.</Trans>} />
        ) : (
          <>
            <div {...stylex.props(styles.list)}>
              {query.data.data.map((incident) => (
                <IncidentItem key={incident.id} incident={incident} />
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
