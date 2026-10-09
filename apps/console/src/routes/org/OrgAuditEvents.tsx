// 组织审计日志:检索 target / IP / 请求 ID,按事件前缀、actor、时间范围筛选;行可展开看事件 JSON。
// 归属与筛选都由后端执行;游标分页只有上一页 / 下一页,时间一律按 UTC 显示。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Dialog, Dropdown, FilterChip, Icon, Skeleton } from '@xid-kit/web-ui/ui'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { AuditEventRow, auditTable } from './AuditEventRow'
import { useOrgAuditLog } from './overview-queries'
import type { AuditEntry, AuditLogQuery } from './overview-queries'
import { useOrgTarget } from './useOrgTarget'

const PAGE_SIZE = 50
const DEBOUNCE_MS = 300
const EVENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}\*?$/
const EVENT_SUGGESTIONS = [
  'user.*',
  'auth.*',
  'membership.*',
  'invitation.*',
  'api_key.*',
  'sso_connection.*',
  'scim.*',
  'webhook.*',
  'organization.*',
]

const RANGES = ['24h', '7d', '30d', '90d'] as const
type Range = (typeof RANGES)[number]
const RANGE_MS: Record<Range, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}
const RANGE_LABELS: Record<Range, MessageDescriptor> = {
  '24h': msg`Last 24 hours`,
  '7d': msg`Last 7 days`,
  '30d': msg`Last 30 days`,
  '90d': msg`Last 90 days`,
}

type Actor = { id: string; label: string }

type Filters = {
  q: string
  eventType: string
  actor: Actor | null
  range: Range | null
}

const EMPTY_FILTERS: Filters = { q: '', eventType: '', actor: null, range: null }

const styles = stylex.create({
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
  },
  eventField: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    alignItems: 'center',
    gap: '0.5rem',
    width: '13.75rem',
    height: '2.25rem',
    paddingInline: '0.75rem 0.625rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: {
      default: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
      ':focus-within': `inset 0 0 0 2px ${tokens['--xid-accent']}`,
    },
    backgroundColor: tokens['--xid-surface'],
    boxSizing: 'border-box',
  },
  eventFieldDialog: {
    display: 'flex',
    width: '100%',
    height: '2.75rem',
  },
  eventInvalid: {
    boxShadow: `inset 0 0 0 2px ${tokens['--xid-danger']}`,
  },
  eventLabel: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.sm,
    flexShrink: 0,
  },
  eventInput: {
    flex: '1 1 auto',
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: { default: text.md, '@media (min-width: 48rem)': text.sm },
    lineHeight: leading.sm,
  },
  wideFilter: {
    display: { default: 'none', '@media (min-width: 64rem)': 'inline-flex' },
  },
  narrowFilter: {
    display: { default: 'inline-flex', '@media (min-width: 64rem)': 'none' },
  },
  summaryRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    minHeight: '1.75rem',
  },
  count: {
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
  },
  countNarrow: {
    display: { default: 'inline', '@media (min-width: 48rem)': 'none' },
    marginInlineStart: 'auto',
  },
  countWide: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
  },
  divider: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    width: '1px',
    height: '1rem',
    backgroundColor: tokens['--xid-border'],
    flexShrink: 0,
  },
  hint: {
    display: { default: 'none', '@media (min-width: 64rem)': 'inline' },
    marginInlineStart: 'auto',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  chipMono: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
  },
  scroller: {
    position: 'relative',
    overflowX: 'auto',
    marginInline: { default: '-1rem', '@media (min-width: 48rem)': 0 },
    paddingInlineStart: { default: '1rem', '@media (min-width: 48rem)': 0 },
  },
  table: {
    width: '100%',
    minWidth: { default: '40rem', '@media (min-width: 64rem)': 0 },
    borderCollapse: 'separate',
    borderSpacing: 0,
    fontFamily: tokens['--xid-font'],
  },
  headCell: {
    height: '2.25rem',
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
    whiteSpace: 'nowrap',
  },
  sortMark: {
    display: 'inline-flex',
    verticalAlign: 'middle',
    marginInlineStart: '0.25rem',
  },
  emptyCell: {
    paddingBlock: '2rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    textAlign: 'center',
  },
  errorPanel: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: '0.75rem 1rem',
    marginTop: '1rem',
    padding: '1rem 1.25rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-warning-bg'],
  },
  errorIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    paddingTop: '0.125rem',
    color: tokens['--xid-warning'],
  },
  errorText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    flex: '1 1 20rem',
    minWidth: 0,
  },
  errorTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  errorBody: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  dialogBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  dialogField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  dialogLabel: {
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
})

function useDebounced<T>(value: T): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value])
  return debounced
}

function activeCount(filters: Filters): number {
  return [filters.eventType.trim(), filters.actor, filters.range].filter(Boolean).length
}

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <label {...stylex.props(list.search)}>
      <span aria-hidden="true" {...stylex.props(list.searchIcon)}>
        <Icon name="search" size={16} />
      </span>
      <input
        type="search"
        value={value}
        maxLength={200}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t`Target ID or IP address`}
        aria-label={t`Search audit events by target ID or IP address`}
        {...stylex.props(list.searchInput)}
      />
    </label>
  )
}

function EventField({
  value,
  onChange,
  inDialog = false,
}: {
  value: string
  onChange: (value: string) => void
  inDialog?: boolean
}): ReactNode {
  const { t } = useLingui()
  const invalid = value.trim() !== '' && !EVENT_PATTERN.test(value.trim())
  const listId = inDialog ? 'audit-event-suggestions-dialog' : 'audit-event-suggestions'
  return (
    <label
      {...stylex.props(
        styles.eventField,
        inDialog && styles.eventFieldDialog,
        invalid && styles.eventInvalid,
      )}
    >
      <span {...stylex.props(styles.eventLabel)}>
        <Trans>Event</Trans>
      </span>
      <input
        value={value}
        list={listId}
        maxLength={101}
        spellCheck={false}
        autoCapitalize="off"
        aria-invalid={invalid}
        aria-label={t`Event type`}
        placeholder={t`user.*`}
        onChange={(event) => onChange(event.currentTarget.value)}
        {...stylex.props(styles.eventInput)}
      />
      <datalist id={listId}>
        {EVENT_SUGGESTIONS.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </label>
  )
}

function ActorMenu({
  value,
  actors,
  onChange,
}: {
  value: Actor | null
  actors: readonly Actor[]
  onChange: (actor: Actor | null) => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <Dropdown
      ariaLabel={t`Actor`}
      align="start"
      triggerStyle={list.filterButton}
      trigger={
        <>
          <span>{value ? value.label : t`Actor`}</span>
          <Icon name="caret-down" size={12} />
        </>
      }
      items={[
        { key: 'any', label: t`Anyone`, checked: value === null, onSelect: () => onChange(null) },
        ...actors.map((actor) => ({
          key: actor.id,
          label: actor.label,
          checked: value?.id === actor.id,
          onSelect: () => onChange(actor),
        })),
      ]}
    />
  )
}

function RangeMenu({
  value,
  onChange,
}: {
  value: Range | null
  onChange: (range: Range | null) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  return (
    <Dropdown
      ariaLabel={t`Time range`}
      align="start"
      triggerStyle={list.filterButton}
      trigger={
        <>
          <span>{value ? i18n._(RANGE_LABELS[value]) : t`Any time`}</span>
          <Icon name="caret-down" size={12} />
        </>
      }
      items={[
        { key: 'any', label: t`Any time`, checked: value === null, onSelect: () => onChange(null) },
        ...RANGES.map((range) => ({
          key: range,
          label: i18n._(RANGE_LABELS[range]),
          checked: value === range,
          onSelect: () => onChange(range),
        })),
      ]}
    />
  )
}

function FiltersDialog({
  open,
  filters,
  actors,
  onClose,
  onApply,
}: {
  open: boolean
  filters: Filters
  actors: readonly Actor[]
  onClose: () => void
  onApply: (filters: Filters) => void
}): ReactNode {
  const [draft, setDraft] = useState(filters)
  useEffect(() => {
    if (open) setDraft(filters)
  }, [open, filters])
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={<Trans>Filter audit events</Trans>}
      position={{ narrow: 'fullscreen', regular: 'side' }}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onApply({ ...EMPTY_FILTERS, q: filters.q })}>
            <Trans>Clear filters</Trans>
          </Button>
          <Button onClick={() => onApply(draft)}>
            <Trans>Show events</Trans>
          </Button>
        </>
      }
    >
      <div {...stylex.props(styles.dialogBody)}>
        <div {...stylex.props(styles.dialogField)}>
          <EventField
            inDialog
            value={draft.eventType}
            onChange={(eventType) => setDraft({ ...draft, eventType })}
          />
          <span {...stylex.props(list.footnote)}>
            <Trans>End an event type with * to match every event that starts with it</Trans>
          </span>
        </div>
        <div {...stylex.props(styles.dialogField)}>
          <span {...stylex.props(styles.dialogLabel)}>
            <Trans>Actor</Trans>
          </span>
          <ActorMenu
            value={draft.actor}
            actors={actors}
            onChange={(actor) => setDraft({ ...draft, actor })}
          />
        </div>
        <div {...stylex.props(styles.dialogField)}>
          <span {...stylex.props(styles.dialogLabel)}>
            <Trans>Time</Trans>
          </span>
          <RangeMenu value={draft.range} onChange={(range) => setDraft({ ...draft, range })} />
        </div>
      </div>
    </Dialog>
  )
}

function FilterChips({
  filters,
  onChange,
}: {
  filters: Filters
  onChange: (filters: Filters) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const chips: { key: string; label: string; value: ReactNode; clear: Partial<Filters> }[] = []
  const eventType = filters.eventType.trim()
  if (eventType) {
    chips.push({
      key: 'event',
      label: t`Event`,
      value: <span {...stylex.props(styles.chipMono)}>{eventType}</span>,
      clear: { eventType: '' },
    })
  }
  if (filters.actor) {
    chips.push({
      key: 'actor',
      label: t`Actor`,
      value: filters.actor.label,
      clear: { actor: null },
    })
  }
  if (filters.range) {
    chips.push({
      key: 'time',
      label: t`Time`,
      value: i18n._(RANGE_LABELS[filters.range]),
      clear: { range: null },
    })
  }
  if (chips.length === 0) return null
  return (
    <>
      <div {...stylex.props(list.chips)}>
        {chips.map((chip) => (
          <FilterChip
            key={chip.key}
            label={chip.label}
            value={chip.value}
            removeLabel={t`Remove filter ${chip.label}`}
            onRemove={() => onChange({ ...filters, ...chip.clear })}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange({ ...EMPTY_FILTERS, q: filters.q })}
        {...stylex.props(list.textButton)}
      >
        <Trans>Clear filters</Trans>
      </button>
    </>
  )
}

function LoadFailure({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div role="alert" {...stylex.props(styles.errorPanel)}>
      <span aria-hidden="true" {...stylex.props(styles.errorIcon)}>
        <Icon name="alert-circle" size={16} />
      </span>
      <div {...stylex.props(styles.errorText)}>
        <p {...stylex.props(styles.errorTitle)}>
          <Trans>The audit log didn't load</Trans>
        </p>
        <p {...stylex.props(styles.errorBody)}>
          <Trans>
            Nothing was lost: entries are still being recorded and will appear when the log loads.
            Try again in a minute. If it keeps failing, contact XID support.
          </Trans>
        </p>
      </div>
      <Button variant="secondary" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  )
}

function useActorOptions(entries: readonly AuditEntry[], selected: Actor | null): Actor[] {
  const { t } = useLingui()
  return useMemo(() => {
    const options = new Map<string, Actor>()
    if (selected) options.set(selected.id, selected)
    for (const entry of entries) {
      if (!entry.actorId || entry.actorId === 'system' || options.has(entry.actorId)) continue
      const name = entry.actor.displayName ?? entry.actorId
      const label = entry.actor.kind === 'api_key' ? t`API key ${name}` : name
      options.set(entry.actorId, { id: entry.actorId, label })
    }
    return [...options.values()]
  }, [entries, selected, t])
}

export default function OrgAuditEvents(): ReactNode {
  const { t, i18n } = useLingui()
  const { orgId, activeOrg } = useOrgTarget()
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : ''
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const [openId, setOpenId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const q = useDebounced(filters.q.trim())
  const eventType = useDebounced(filters.eventType.trim())
  const rangeFrom = useMemo(
    () =>
      filters.range ? new Date(Date.now() - RANGE_MS[filters.range]).toISOString() : undefined,
    [filters.range],
  )
  const cursor = cursors[cursors.length - 1] ?? null

  const query: AuditLogQuery = {
    q: q || undefined,
    event_type: EVENT_PATTERN.test(eventType) ? eventType : undefined,
    actor_id: filters.actor?.id,
    occurred_from: rangeFrom,
    cursor: cursor ?? undefined,
    limit: String(PAGE_SIZE),
  }
  const events = useOrgAuditLog(orgId, query)
  const page = events.data
  const actors = useActorOptions(page?.data ?? [], filters.actor)
  const active = activeCount(filters)
  const filtered = active > 0 || q !== ''

  const updateFilters = (next: Filters) => {
    setCursors([null])
    setOpenId(null)
    setFilters(next)
  }
  useEffect(() => {
    setCursors([null])
    setOpenId(null)
  }, [q, eventType])

  if (!orgId) {
    return (
      <PageFrame title={<Trans>Audit log</Trans>}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </PageFrame>
    )
  }

  const total = i18n.number(page?.total ?? 0)
  const countLabel =
    events.isError && !page ? (
      <Trans>Events not loaded</Trans>
    ) : page ? (
      <Plural value={page.total} one="# event" other="# events" />
    ) : null

  return (
    <PageFrame
      title={<Trans>Audit log</Trans>}
      lead={
        <Trans>
          Every change made in {orgName} by people, API keys and directory sync. Entries are
          append-only and can't be edited or deleted.
        </Trans>
      }
    >
      <div role="search" aria-label={t`Filter audit events`} {...stylex.props(styles.bar)}>
        <SearchBox value={filters.q} onChange={(value) => setFilters({ ...filters, q: value })} />
        <EventField
          value={filters.eventType}
          onChange={(value) => setFilters({ ...filters, eventType: value })}
        />
        <span {...stylex.props(styles.wideFilter)}>
          <ActorMenu
            value={filters.actor}
            actors={actors}
            onChange={(actor) => updateFilters({ ...filters, actor })}
          />
        </span>
        <span {...stylex.props(styles.wideFilter)}>
          <RangeMenu
            value={filters.range}
            onChange={(range) => updateFilters({ ...filters, range })}
          />
        </span>
        <span {...stylex.props(styles.narrowFilter)}>
          <Button variant="secondary" onClick={() => setDialogOpen(true)}>
            <Icon name="list-status" size={16} />
            {active > 0 ? <Trans>Filters ({active})</Trans> : <Trans>Filters</Trans>}
          </Button>
        </span>
        {countLabel ? (
          <span {...stylex.props(styles.count, styles.countNarrow)}>{countLabel}</span>
        ) : null}
      </div>

      <div {...stylex.props(styles.summaryRow)}>
        {countLabel ? (
          <>
            <span {...stylex.props(styles.count, styles.countWide)}>{countLabel}</span>
            <span aria-hidden="true" {...stylex.props(styles.divider)} />
          </>
        ) : null}
        <FilterChips filters={filters} onChange={updateFilters} />
        <span {...stylex.props(styles.hint)}>
          <Trans>End an event type with * to match every event that starts with it</Trans>
        </span>
      </div>

      <div {...stylex.props(styles.scroller)}>
        <table {...stylex.props(styles.table)}>
          <caption {...stylex.props(visuallyHidden.text)}>
            <Trans>Audit events, newest first. {total} in total.</Trans>
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                {...stylex.props(auditTable.cell, auditTable.timeCell, styles.headCell)}
              >
                <Trans>Time (UTC)</Trans>
                <span aria-hidden="true" {...stylex.props(styles.sortMark)}>
                  <Icon name="caret-down" size={12} />
                </span>
              </th>
              <th scope="col" {...stylex.props(auditTable.cell, styles.headCell)}>
                <Trans>Event</Trans>
              </th>
              <th
                scope="col"
                {...stylex.props(auditTable.cell, auditTable.sourceCell, styles.headCell)}
              >
                <Trans>Source</Trans>
              </th>
              <th
                scope="col"
                {...stylex.props(auditTable.cell, auditTable.toggleCell, styles.headCell)}
              >
                <span {...stylex.props(visuallyHidden.text)}>
                  <Trans>Details</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {events.isLoading ? (
              [0, 1, 2, 3, 4].map((index) => (
                <tr key={index}>
                  <td colSpan={4} {...stylex.props(auditTable.cell)}>
                    <Skeleton width="70%" height="1rem" />
                  </td>
                </tr>
              ))
            ) : page && page.data.length === 0 ? (
              <tr>
                <td colSpan={4} {...stylex.props(styles.emptyCell)}>
                  {filtered ? (
                    <>
                      <Trans>No events match these filters.</Trans>{' '}
                      <button
                        type="button"
                        onClick={() => updateFilters(EMPTY_FILTERS)}
                        {...stylex.props(list.textButton)}
                      >
                        <Trans>Clear filters</Trans>
                      </button>
                    </>
                  ) : (
                    <Trans>
                      Nothing has been recorded yet. Changes made in the Console, through the
                      Management API or by directory sync appear here.
                    </Trans>
                  )}
                </td>
              </tr>
            ) : (
              page?.data.map((entry) => (
                <AuditEventRow
                  key={entry.id}
                  entry={entry}
                  orgId={orgId}
                  open={openId === entry.id}
                  onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {events.isError && !page ? <LoadFailure onRetry={() => void events.refetch()} /> : null}

      {page && page.data.length > 0 ? (
        <div {...stylex.props(list.footer)}>
          <p {...stylex.props(list.footnote)}>
            <Trans>Newest first, 50 per page. Times are shown in UTC.</Trans>
          </p>
          <div {...stylex.props(list.pager)}>
            <Button
              variant="secondary"
              disabled={cursors.length <= 1 || events.isFetching}
              onClick={() => {
                setOpenId(null)
                setCursors(cursors.slice(0, -1))
              }}
              {...stylex.props(list.pagerButton)}
            >
              <Trans>Previous</Trans>
            </Button>
            <Button
              variant="secondary"
              disabled={!page.has_more || events.isFetching}
              onClick={() => {
                setOpenId(null)
                setCursors([...cursors, page.next_cursor])
              }}
              {...stylex.props(list.pagerButton)}
            >
              <Trans>Next</Trans>
            </Button>
          </div>
        </div>
      ) : null}

      <FiltersDialog
        open={dialogOpen}
        filters={filters}
        actors={actors}
        onClose={() => setDialogOpen(false)}
        onApply={(next) => {
          setDialogOpen(false)
          updateFilters(next)
        }}
      />
    </PageFrame>
  )
}

const visuallyHidden = stylex.create({
  text: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
})
