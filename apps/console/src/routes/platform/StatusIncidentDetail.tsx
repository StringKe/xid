import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { StatusIncident, XidError } from '@xid-kit/types'
import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  CheckboxField,
  Field,
  SegmentedControl,
  Skeleton,
  Textarea,
} from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { formatUtcDateTime } from './PlatformAttention'
import {
  STATUS_INCIDENT_COMPONENTS,
  usePostStatusIncidentUpdate,
  useStatusIncident,
} from './ops-queries'
import type { PlatformStatusIncident, StatusIncidentComponent } from './ops-queries'
import { useDeleteStatusIncident } from './queries'

export const STATUS_INCIDENTS_PATH = '/console/platform/status'
const NARROW = '@media (max-width: 48rem)'

const COMPONENT_LABELS = {
  hosted_sign_in: msg`Hosted sign-in`,
  token_endpoint: msg`Token endpoint`,
  management_api: msg`Management API`,
  console: msg`Console`,
  email_delivery: msg`Email delivery`,
  sms_delivery: msg`SMS delivery`,
  whatsapp_delivery: msg`WhatsApp delivery`,
  webhooks: msg`Webhooks`,
} as const satisfies Record<StatusIncidentComponent, unknown>

const STATUS_LABELS = {
  investigating: msg`Investigating`,
  identified: msg`Identified`,
  monitoring: msg`Monitoring`,
  resolved: msg`Resolved`,
} as const satisfies Record<StatusIncident['status'], unknown>

const IMPACT_LABELS = {
  none: msg`No customer impact`,
  minor: msg`Degraded`,
  major: msg`Partial outage`,
  critical: msg`Major outage`,
} as const satisfies Record<StatusIncident['impact'], unknown>

export function componentList(i18n: I18n, components: readonly StatusIncidentComponent[]): string {
  return new Intl.ListFormat(i18n.locale, { type: 'conjunction', style: 'narrow' }).format(
    components.map((component) => i18n._(COMPONENT_LABELS[component])),
  )
}

export function incidentStatusLabel(i18n: I18n, status: StatusIncident['status']): string {
  return i18n._(STATUS_LABELS[status])
}

export function incidentImpactLabel(i18n: I18n, impact: StatusIncident['impact']): string {
  return i18n._(IMPACT_LABELS[impact])
}

export function incidentStatusTone(status: StatusIncident['status']): BadgeTone {
  if (status === 'resolved') return 'success'
  if (status === 'monitoring') return 'info'
  return 'warning'
}

export function ComponentChoices({
  value,
  onChange,
}: {
  value: readonly StatusIncidentComponent[]
  onChange: (next: StatusIncidentComponent[]) => void
}): ReactNode {
  const { i18n, t } = useLingui()
  return (
    <fieldset {...stylex.props(styles.fieldset)}>
      <legend {...stylex.props(styles.legend)}>{t`Affected components`}</legend>
      <div {...stylex.props(styles.components)}>
        {STATUS_INCIDENT_COMPONENTS.map((component) => (
          <CheckboxField
            key={component}
            label={i18n._(COMPONENT_LABELS[component])}
            checked={value.includes(component)}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...value, component]
                  : value.filter((selected) => selected !== component),
              )
            }
          />
        ))}
      </div>
    </fieldset>
  )
}

const styles = stylex.create({
  header: {
    display: 'grid',
    gap: '0.75rem',
    marginBottom: '1.75rem',
  },
  titleRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: { default: text.xl, [NARROW]: text.lg },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  meta: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
  },
  layout: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr) minmax(0, 0.8fr)', [NARROW]: '1fr' },
    gap: { default: '3rem', [NARROW]: '2rem' },
    alignItems: 'start',
  },
  sectionTitle: {
    margin: '0 0 1rem',
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.display,
  },
  form: {
    display: 'grid',
    gap: '1.25rem',
  },
  fieldLabel: {
    margin: '0 0 0.5rem',
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  fieldset: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    display: 'grid',
    gap: '0.5rem',
  },
  legend: {
    padding: 0,
    marginBottom: '0.5rem',
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  components: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: '1.25rem',
    rowGap: '0.5rem',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    alignItems: 'center',
  },
  secondaryLink: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '2.25rem',
    paddingInline: '0.875rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecoration: 'none',
  },
  deleteRow: {
    marginTop: '0.5rem',
  },
  timeline: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  update: {
    position: 'relative',
    paddingInlineStart: '1.5rem',
    paddingBottom: '1.25rem',
    borderInlineStartWidth: '1px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    marginInlineStart: '0.3125rem',
  },
  updateLast: {
    borderInlineStartColor: 'transparent',
  },
  dot: {
    position: 'absolute',
    insetInlineStart: '-0.3125rem',
    top: '0.3125rem',
    width: '0.625rem',
    height: '0.625rem',
    borderRadius: tokens['--xid-radius-full'],
    borderWidth: '1.5px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-fg'],
    backgroundColor: tokens['--xid-bg'],
  },
  dotCurrent: {
    backgroundColor: tokens['--xid-fg'],
  },
  updateHead: {
    margin: 0,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '0.5rem',
  },
  updateStatus: {
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.display,
  },
  updateMeta: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  updateMessage: {
    margin: '0.375rem 0 0',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
  },
  empty: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
})

function UpdateTimeline({ incident }: { incident: PlatformStatusIncident }): ReactNode {
  const { i18n } = useLingui()
  if (incident.updates.length === 0) {
    return (
      <p {...stylex.props(styles.empty)}>
        <Trans>No public update has been posted yet.</Trans>
      </p>
    )
  }
  return (
    <ol {...stylex.props(styles.timeline)}>
      {incident.updates.map((update, index) => {
        const when = formatUtcDateTime(i18n, update.createdAt)
        const author = update.createdByName ?? update.createdBy
        const last = index === incident.updates.length - 1
        return (
          <li key={update.id} {...stylex.props(styles.update, last && styles.updateLast)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.dot, index === 0 && styles.dotCurrent)}
            />
            <p {...stylex.props(styles.updateHead)}>
              <span {...stylex.props(styles.updateStatus)}>
                {incidentStatusLabel(i18n, update.status)}
              </span>
              <span {...stylex.props(styles.updateMeta)}>
                <Trans>
                  {when} by {author}
                </Trans>
              </span>
            </p>
            <p {...stylex.props(styles.updateMessage)}>{update.message}</p>
          </li>
        )
      })}
    </ol>
  )
}

function writeError(
  error: XidError | null,
  t: ReturnType<typeof useLingui>['t'],
  fallback: (error: XidError) => string,
): string | undefined {
  if (!error) return undefined
  if (error.code === 'conflict') {
    return t`Another instance manager updated this incident. Review the latest update and try again.`
  }
  return fallback(error)
}

function PostUpdateForm({ incident }: { incident: PlatformStatusIncident }): ReactNode {
  const { i18n, t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const post = usePostStatusIncidentUpdate()
  const [status, setStatus] = useState<StatusIncident['status']>(incident.status)
  const [message, setMessage] = useState('')
  const [components, setComponents] = useState<StatusIncidentComponent[]>(incident.components)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    post.mutate(
      { id: incident.id, status, message, components },
      {
        onSuccess: (updated) => {
          setMessage('')
          setStatus(updated.status)
          setComponents(updated.components)
        },
      },
    )
  }

  const statusOptions = (Object.keys(STATUS_LABELS) as StatusIncident['status'][]).map((value) => ({
    value,
    label: incidentStatusLabel(i18n, value),
  }))
  const error = writeError(post.error, t, (value) => errorMessage(value, { surface: 'general' }))

  return (
    <form {...stylex.props(styles.form)} onSubmit={submit}>
      <div>
        <p {...stylex.props(styles.fieldLabel)}>
          <Trans>Status</Trans>
        </p>
        <SegmentedControl
          ariaLabel={t`Status`}
          options={statusOptions}
          value={status}
          onValueChange={(value) => setStatus(value as StatusIncident['status'])}
        />
      </div>
      <Field
        label={t`Message`}
        hint={<Trans>Shown publicly as written. Do not include customer names.</Trans>}
      >
        <Textarea
          required
          rows={4}
          maxLength={4000}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      </Field>
      <ComponentChoices value={components} onChange={setComponents} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {post.isSuccess && !post.isPending ? (
        <Alert tone="success">
          <Trans>Update posted. Customers see it on the public status API now.</Trans>
        </Alert>
      ) : null}
      <div {...stylex.props(styles.actions)}>
        <Button type="submit" isLoading={post.isPending} disabled={message.trim().length === 0}>
          {status === 'resolved' && incident.status !== 'resolved' ? (
            <Trans>Post update and resolve</Trans>
          ) : (
            <Trans>Post update</Trans>
          )}
        </Button>
        <a
          href="/v1/public/status"
          target="_blank"
          rel="noopener"
          {...stylex.props(styles.secondaryLink)}
        >
          <Trans>View public status data</Trans>
        </a>
      </div>
    </form>
  )
}

export function StatusIncidentDetail({ incidentId }: { incidentId: string }): ReactNode {
  const { i18n, t } = useLingui()
  const navigate = useNavigate()
  const errorMessage = useApiErrorMessage()
  const incident = useStatusIncident(incidentId)
  const remove = useDeleteStatusIncident()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const data = incident.data

  const crumbs = [
    { key: 'list', label: t`Status incidents`, href: STATUS_INCIDENTS_PATH },
    { key: 'current', label: data?.title ?? t`Incident` },
  ]

  if (incident.isLoading) {
    return (
      <div {...stylex.props(styles.header)}>
        <Breadcrumb items={crumbs} />
        <Skeleton height="2.5rem" />
        <Skeleton height="12rem" />
      </div>
    )
  }
  if (!data) {
    return (
      <div {...stylex.props(styles.header)}>
        <Breadcrumb items={crumbs} />
        <Alert tone="error">
          {incident.error?.code === 'not_found' ? (
            <Trans>This incident no longer exists.</Trans>
          ) : (
            <Trans>The incident could not be loaded.</Trans>
          )}
        </Alert>
      </div>
    )
  }

  const impact = incidentImpactLabel(i18n, data.impact)
  const started = formatUtcDateTime(i18n, data.startedAt)
  const components = componentList(i18n, data.components)
  return (
    <>
      <header {...stylex.props(styles.header)}>
        <Breadcrumb items={crumbs} />
        <div {...stylex.props(styles.titleRow)}>
          <h1 {...stylex.props(styles.title)}>{data.title}</h1>
          <Badge tone={incidentStatusTone(data.status)}>
            {incidentStatusLabel(i18n, data.status)}
          </Badge>
        </div>
        <p {...stylex.props(styles.meta)}>
          {components ? (
            <Trans>
              {components}, {impact}. Started {started}.
            </Trans>
          ) : (
            <Trans>
              {impact}. Started {started}.
            </Trans>
          )}
        </p>
      </header>

      <div {...stylex.props(styles.layout)}>
        <section aria-labelledby="incident-post-update">
          <h2 id="incident-post-update" {...stylex.props(styles.sectionTitle)}>
            <Trans>Post an update</Trans>
          </h2>
          <PostUpdateForm incident={data} />
          <div {...stylex.props(styles.deleteRow)}>
            <Button
              variant="ghost"
              onClick={() => {
                remove.reset()
                setConfirmDelete(true)
              }}
            >
              <Trans>Delete incident…</Trans>
            </Button>
          </div>
        </section>
        <section aria-labelledby="incident-updates">
          <h2 id="incident-updates" {...stylex.props(styles.sectionTitle)}>
            <Trans>Updates</Trans>
          </h2>
          <UpdateTimeline incident={data} />
        </section>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title={<Trans>Delete this incident?</Trans>}
          description={
            <Trans>
              The incident and its public timeline are removed from the status API. Use this only
              for incidents opened by mistake; resolve real incidents instead.
            </Trans>
          }
          confirmLabel={<Trans>Delete incident</Trans>}
          isLoading={remove.isPending}
          error={writeError(remove.error, t, (value) =>
            errorMessage(value, { surface: 'general' }),
          )}
          onConfirm={() =>
            remove.mutate({ id: data.id }, { onSuccess: () => navigate(STATUS_INCIDENTS_PATH) })
          }
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  )
}
