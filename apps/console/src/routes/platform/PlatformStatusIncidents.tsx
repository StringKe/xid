
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
  useAppendStatusIncidentUpdate,
  useCreateStatusIncident,
  useDeleteStatusIncident,
  usePlatformStatusIncidentsQuery,
  useUpdateStatusIncident,
} from './queries'
import type { StatusIncident } from './types'

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

type IncidentItemProps = {
  incident: StatusIncident
  isAppending: boolean
  isResolving: boolean
  onAppend: (
    incident: StatusIncident,
    status: StatusIncident['status'],
    message: string,
    onSuccess: () => void,
  ) => void
  onResolve: (incident: StatusIncident) => void
  onDelete: (incident: StatusIncident) => void
}

function IncidentItem({
  incident,
  isAppending,
  isResolving,
  onAppend,
  onResolve,
  onDelete,
}: IncidentItemProps): ReactNode {
  const { t } = useLingui()
  const [status, setStatus] = useState<StatusIncident['status']>(incident.status)
  const [message, setMessage] = useState('')

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onAppend(incident, status, message, () => setMessage(''))
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
        <Field label={t`Next status`}>
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusIncident['status'])}
          >
            <option value="investigating">{t`Investigating`}</option>
            <option value="identified">{t`Identified`}</option>
            <option value="monitoring">{t`Monitoring`}</option>
            <option value="resolved">{t`Resolved`}</option>
          </Select>
        </Field>
        <Field label={t`Public update`}>
          <Textarea
            required
            maxLength={4000}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
        <div {...stylex.props(styles.actions)}>
          <Button type="submit" isLoading={isAppending}>
            <Trans>Publish update</Trans>
          </Button>
          {incident.status !== 'resolved' ? (
            <Button
              type="button"
              variant="secondary"
              isLoading={isResolving}
              onClick={() => onResolve(incident)}
              aria-label={t`Resolve incident ${incident.title}`}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Resolve incident</Trans>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            onClick={() => onDelete(incident)}
            aria-label={t`Delete incident ${incident.title}`}
            {...stylex.props(consoleShell.actionButton)}
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
  const append = useAppendStatusIncidentUpdate()
  const update = useUpdateStatusIncident()
  const remove = useDeleteStatusIncident()
  const [pendingDelete, setPendingDelete] = useState<StatusIncident | null>(null)
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

  function handleAppend(
    incident: StatusIncident,
    status: StatusIncident['status'],
    message: string,
    onSuccess: () => void,
  ): void {
    append.mutate({ id: incident.id, status, message }, { onSuccess })
  }

  function handleResolve(incident: StatusIncident): void {
    update.mutate({
      id: incident.id,
      body: { status: 'resolved', resolvedAt: new Date().toISOString() },
    })
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    await remove.mutateAsync({ id: pendingDelete.id })
    setPendingDelete(null)
  }

  return (
    <ConsolePage
      title={<Trans>Status incidents</Trans>}
      lead={
        <Trans>
          Keep the public status page current with incident impact, state, and timestamped updates.
        </Trans>
      }
    >
      {query.isError ||
      create.isError ||
      create.isSuccess ||
      append.isError ||
      update.isError ||
      remove.isError ? (
        <ConsolePageNotice>
          {query.isError ? (
            <Alert tone="error">
              <Trans>Failed to load status incidents.</Trans>
            </Alert>
          ) : null}
          {create.isError ? (
            <Alert tone="error">
              <Trans>Failed to open the incident. Try again.</Trans>
            </Alert>
          ) : null}
          {create.isSuccess ? (
            <Alert tone="success">
              <Trans>Incident opened.</Trans>
            </Alert>
          ) : null}
          {append.isError ? (
            <Alert tone="error">
              <Trans>Failed to publish the update. Try again.</Trans>
            </Alert>
          ) : null}
          {update.isError ? (
            <Alert tone="error">
              <Trans>Failed to resolve the incident. Try again.</Trans>
            </Alert>
          ) : null}
          {remove.isError ? (
            <Alert tone="error">
              <Trans>Failed to delete the incident. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSplitSection
        title={<Trans>Open incident</Trans>}
        description={<Trans>Declare the incident, its public impact, and when it started.</Trans>}
      >
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
            <Select
              value={impact}
              onChange={(event) => setImpact(event.target.value as StatusIncident['impact'])}
            >
              <option value="none">{t`None`}</option>
              <option value="minor">{t`Minor`}</option>
              <option value="major">{t`Major`}</option>
              <option value="critical">{t`Critical`}</option>
            </Select>
          </Field>
          <div {...stylex.props(styles.full)}>
            <Field label={t`Public summary`}>
              <Textarea
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
      </ConsolePageSplitSection>

      <ConsolePageSection title={<Trans>Incident ledger</Trans>}>
        {query.isLoading ? (
          <div {...stylex.props(styles.skeletonStack)}>
            <Skeleton height="8rem" />
            <Skeleton height="8rem" />
            <Skeleton height="8rem" />
          </div>
        ) : null}
        {!query.isLoading && query.data && query.data.data.length === 0 ? (
          <EmptyState title={<Trans>No incidents have been reported.</Trans>} />
        ) : null}
        {query.data && query.data.data.length > 0 ? (
          <>
            <div {...stylex.props(styles.list)}>
              {query.data.data.map((incident) => (
                <IncidentItem
                  key={incident.id}
                  incident={incident}
                  isAppending={append.isPending && append.variables?.id === incident.id}
                  isResolving={update.isPending && update.variables?.id === incident.id}
                  onAppend={handleAppend}
                  onResolve={handleResolve}
                  onDelete={setPendingDelete}
                />
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
          title={<Trans>Delete incident?</Trans>}
          description={
            <Trans>
              The incident {pendingDelete.title} and all of its updates will be permanently deleted.
            </Trans>
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
