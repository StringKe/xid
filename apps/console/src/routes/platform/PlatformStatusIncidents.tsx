import type { I18n } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { StatusIncident } from '@xid-kit/types'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Textarea,
} from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { frame } from '../../components/page/PageFrame'
import { fromLocalDateTime, nowLocalDateTime } from '../../lib/datetime-local'
import { formatRelativeTime } from './PlatformAttention'
import {
  ComponentChoices,
  STATUS_INCIDENTS_PATH,
  StatusIncidentDetail,
  componentList,
  incidentImpactLabel,
  incidentStatusLabel,
  incidentStatusTone,
} from './StatusIncidentDetail'
import { useOpenStatusIncident, useStatusIncidents } from './ops-queries'
import type { PlatformStatusIncident, StatusIncidentComponent } from './ops-queries'

const DAY_MS = 24 * 60 * 60 * 1000
const NARROW = '@media (max-width: 40rem)'

const styles = stylex.create({
  title: {
    display: 'block',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
  },
  sub: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  stale: {
    color: tokens['--xid-warning'],
    fontWeight: weight.medium,
  },
  number: {
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
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

function lastUpdateText(i18n: I18n, incident: PlatformStatusIncident): string {
  const at = incident.lastUpdateAt ?? incident.updatedAt
  if (Date.now() - new Date(at).getTime() < DAY_MS) return formatRelativeTime(i18n, at)
  return i18n.date(new Date(at), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

function useIncidentColumns(): ColumnDef<PlatformStatusIncident>[] {
  const { i18n } = useLingui()
  return useMemo<ColumnDef<PlatformStatusIncident>[]>(
    () => [
      {
        id: 'incident',
        header: () => <Trans>Incident</Trans>,
        cell: ({ row }) => (
          <>
            <span {...stylex.props(styles.title)}>{row.original.title}</span>
            <span {...stylex.props(styles.sub)}>
              {componentList(i18n, row.original.components)}
            </span>
          </>
        ),
        meta: { priority: 'primary' },
      },
      {
        id: 'status',
        header: () => <Trans>Status</Trans>,
        cell: ({ row }) => (
          <Badge tone={incidentStatusTone(row.original.status)}>
            {incidentStatusLabel(i18n, row.original.status)}
          </Badge>
        ),
        meta: { width: '9rem', priority: 'primary' },
      },
      {
        id: 'impact',
        header: () => <Trans>Impact</Trans>,
        cell: ({ row }) => incidentImpactLabel(i18n, row.original.impact),
        meta: { width: '9rem', priority: 'secondary' },
      },
      {
        id: 'started',
        header: () => <Trans>Started</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.number)}>
            {i18n.date(new Date(row.original.startedAt), {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            })}
          </span>
        ),
        meta: { width: '9rem', align: 'end', priority: 'secondary' },
      },
      {
        id: 'lastUpdate',
        header: () => <Trans>Last update</Trans>,
        cell: ({ row }) => (
          <span
            {...stylex.props(styles.number, row.original.status !== 'resolved' && styles.stale)}
          >
            {lastUpdateText(i18n, row.original)}
          </span>
        ),
        meta: { width: '9rem', align: 'end', priority: 'secondary' },
      },
    ],
    [i18n],
  )
}

type OpenForm = {
  title: string
  summary: string
  impact: StatusIncident['impact']
  startedAt: string
  components: StatusIncidentComponent[]
}

function emptyForm(): OpenForm {
  return { title: '', summary: '', impact: 'minor', startedAt: nowLocalDateTime(), components: [] }
}

function OpenIncidentDialog({
  open,
  onOpenChange,
  onOpened,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpened: (incident: PlatformStatusIncident) => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const create = useOpenStatusIncident()
  const [form, setForm] = useState<OpenForm>(emptyForm)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const startedAt = fromLocalDateTime(form.startedAt)
    if (!startedAt) return
    create.mutate(
      {
        title: form.title,
        summary: form.summary,
        impact: form.impact,
        status: 'investigating',
        startedAt,
        components: form.components,
      },
      {
        onSuccess: (incident) => {
          setForm(emptyForm())
          onOpened(incident)
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={<Trans>Open incident</Trans>}
      description={
        <Trans>
          Customers see the title, impact and summary on the public status API right away.
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
        <div {...stylex.props(styles.twoUp)}>
          <Field label={t`Impact`}>
            <Select
              value={form.impact}
              onChange={(event) =>
                setForm({ ...form, impact: event.target.value as StatusIncident['impact'] })
              }
            >
              <option value="minor">{t`Degraded`}</option>
              <option value="major">{t`Partial outage`}</option>
              <option value="critical">{t`Major outage`}</option>
              <option value="none">{t`No customer impact`}</option>
            </Select>
          </Field>
          <Field label={t`Started at`}>
            <Input
              type="datetime-local"
              required
              value={form.startedAt}
              onChange={(event) => setForm({ ...form, startedAt: event.target.value })}
            />
          </Field>
        </div>
        <Field
          label={t`Summary`}
          hint={<Trans>Shown publicly as written. Do not include customer names.</Trans>}
        >
          <Textarea
            required
            rows={3}
            maxLength={4000}
            value={form.summary}
            onChange={(event) => setForm({ ...form, summary: event.target.value })}
          />
        </Field>
        <ComponentChoices
          value={form.components}
          onChange={(components) => setForm({ ...form, components })}
        />
        {create.error ? (
          <Alert tone="error">{errorMessage(create.error, { surface: 'general' })}</Alert>
        ) : null}
        <div {...stylex.props(styles.footer)}>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" isLoading={create.isPending}>
            <Trans>Open incident</Trans>
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function IncidentList(): ReactNode {
  const { i18n } = useLingui()
  const navigate = useNavigate()
  const incidents = useStatusIncidents()
  const columns = useIncidentColumns()
  const [opening, setOpening] = useState(false)
  const rows = incidents.data?.data ?? []
  const openIncident = rows.find((incident) => incident.status !== 'resolved')
  const lastPublic = openIncident ? lastUpdateText(i18n, openIncident) : null

  function openDetail(incident: PlatformStatusIncident): void {
    navigate(`${STATUS_INCIDENTS_PATH}?incidentId=${encodeURIComponent(incident.id)}`)
  }

  return (
    <ConsolePage
      title={<Trans>Status incidents</Trans>}
      lead={
        <Trans>
          What customers see through the public status API. Incidents are opened by people; this
          instance does not probe itself.
        </Trans>
      }
      actions={
        <Button onClick={() => setOpening(true)}>
          <Icon name="plus" />
          <Trans>Open incident</Trans>
        </Button>
      }
    >
      {incidents.isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Status incidents could not be loaded.</Trans>{' '}
            <Button variant="secondary" onClick={() => void incidents.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={incidents.isLoading}
          onRowClick={openDetail}
          narrowMode="priority"
          emptyMessage={
            <Trans>
              No incidents yet. Open one when customers are affected so they can follow along.
            </Trans>
          }
        />
        <LoadMore query={incidents} loadMoreLabel={<Trans>Load more incidents</Trans>} />
        {lastPublic ? (
          <p {...stylex.props(styles.note)}>
            <Trans>
              The open incident's last public update was {lastPublic}. Customers see that time next
              to it.
            </Trans>
          </p>
        ) : null}
      </ConsolePageSection>

      <OpenIncidentDialog open={opening} onOpenChange={setOpening} onOpened={openDetail} />
    </ConsolePage>
  )
}

export default function PlatformStatusIncidents(): ReactNode {
  const [searchParams] = useSearchParams()
  const incidentId = searchParams.get('incidentId')
  if (incidentId) {
    return (
      <div {...stylex.props(frame.root)}>
        <StatusIncidentDetail key={incidentId} incidentId={incidentId} />
      </div>
    )
  }
  return <IncidentList />
}
