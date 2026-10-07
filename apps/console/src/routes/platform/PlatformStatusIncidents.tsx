import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { FormattedDate } from '../../components/FormattedDate'
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
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { StatusIncident, XidError } from '@xid-kit/types'
import { fromLocalDateTime, nowLocalDateTime } from '../../lib/datetime-local'
import {
  useAppendStatusIncidentUpdate,
  useCreateStatusIncident,
  useDeleteStatusIncident,
  usePlatformStatusIncidentsList,
} from './queries'

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
  onAppend: (
    incident: StatusIncident,
    status: StatusIncident['status'],
    message: string,
    onSuccess: () => void,
  ) => void
  onDelete: (incident: StatusIncident) => void
}

function IncidentItem({ incident, isAppending, onAppend, onDelete }: IncidentItemProps): ReactNode {
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
            <FormattedDate value={incident.startedAt} time />
          </span>
        </div>
        {incident.updates.length ? (
          <ol {...stylex.props(styles.timeline)}>
            {incident.updates.map((update) => (
              <li key={update.id} {...stylex.props(styles.timelineItem)}>
                <time dateTime={update.createdAt}>
                  <FormattedDate value={update.createdAt} time />
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
        <Field
          label={t`Public update`}
          hint={
            <Trans>
              To resolve the incident, choose Resolved and describe the fix. Every status change is
              published on the status page timeline.
            </Trans>
          }
        >
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
  const errorMessage = useApiErrorMessage()
  const incidents = usePlatformStatusIncidentsList()
  const incidentRows = incidents.data?.data ?? []
  const create = useCreateStatusIncident()
  const append = useAppendStatusIncidentUpdate()
  const remove = useDeleteStatusIncident()
  const [pendingDelete, setPendingDelete] = useState<StatusIncident | null>(null)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [impact, setImpact] = useState<StatusIncident['impact']>('minor')
  const [startedAt, setStartedAt] = useState(nowLocalDateTime)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const startedAtIso = fromLocalDateTime(startedAt)
    if (!startedAtIso) return
    create.mutate(
      {
        title,
        summary,
        impact,
        status: 'investigating',
        startedAt: startedAtIso,
      },
      {
        onSuccess: () => {
          setTitle('')
          setSummary('')
          setImpact('minor')
          setStartedAt(nowLocalDateTime())
        },
      },
    )
  }

  function writeError(error: XidError | null): string | undefined {
    if (!error) return undefined
    if (error.code === 'conflict') {
      return t`Another administrator updated this incident. The list was refreshed; review it and try again.`
    }
    return errorMessage(error, { surface: 'general' })
  }

  function handleAppend(
    incident: StatusIncident,
    status: StatusIncident['status'],
    message: string,
    onSuccess: () => void,
  ): void {
    append.mutate({ id: incident.id, status, message }, { onSuccess })
  }

  function confirmDelete(): void {
    if (!pendingDelete) return
    remove.mutate({ id: pendingDelete.id }, { onSuccess: () => setPendingDelete(null) })
  }

  function openDelete(incident: StatusIncident): void {
    remove.reset()
    setPendingDelete(incident)
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
      {incidents.isError || create.error || create.isSuccess || append.error ? (
        <ConsolePageNotice>
          {incidents.isError ? (
            <Alert tone="error">
              <Trans>Failed to load status incidents.</Trans>
            </Alert>
          ) : null}
          {create.error ? <Alert tone="error">{writeError(create.error)}</Alert> : null}
          {create.isSuccess ? (
            <Alert tone="success">
              <Trans>Incident opened.</Trans>
            </Alert>
          ) : null}
          {append.error ? <Alert tone="error">{writeError(append.error)}</Alert> : null}
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
        {incidents.isLoading ? (
          <div {...stylex.props(styles.skeletonStack)}>
            <Skeleton height="8rem" />
            <Skeleton height="8rem" />
            <Skeleton height="8rem" />
          </div>
        ) : null}
        {!incidents.isLoading && !incidents.isError && incidentRows.length === 0 ? (
          <EmptyState title={<Trans>No incidents have been reported.</Trans>} />
        ) : null}
        {incidentRows.length > 0 ? (
          <>
            <div {...stylex.props(styles.list)}>
              {incidentRows.map((incident) => (
                <IncidentItem
                  key={`${incident.id}:${incident.updatedAt}`}
                  incident={incident}
                  isAppending={append.isPending && append.variables?.id === incident.id}
                  onAppend={handleAppend}
                  onDelete={openDelete}
                />
              ))}
            </div>
            <LoadMore query={incidents} loadMoreLabel={<Trans>Load more</Trans>} />
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
          error={writeError(remove.error)}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
