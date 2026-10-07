// 用户列表筛选栏:检索、状态、登录方式、更多筛选(日期区间);导出 CSV 与创建用户在右侧。
// 桌面四个控件并排;平板把登录方式收进 Filters;手机只留检索与 Filters,导出也收进 Filters。

import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Dialog, Dropdown, Field, FilterChip, Icon, Input } from '@xid-kit/web-ui/ui'
import { list } from '../../components/page/list-styles'
import type { UserCounts } from './user-api'
import type { SignInMethodFilter, UserFilters, UserStatusFilter } from './user-filters'
import {
  EMPTY_USER_FILTERS,
  SIGN_IN_METHOD_OPTIONS,
  USER_STATUS_OPTIONS,
  activeFilterCount,
  exportHref,
} from './user-filters'

const STATUS_LABELS: Record<UserStatusFilter, MessageDescriptor> = {
  active: msg`Active`,
  banned: msg`Suspended`,
  deleted: msg`Deleted`,
}

const METHOD_LABELS: Record<SignInMethodFilter, MessageDescriptor> = {
  password: msg`Password`,
  passkey: msg`Passkey`,
  social: msg`Social login`,
  sso: msg`Enterprise SSO`,
  guest: msg`Guest session`,
}

const SEARCH_DEBOUNCE_MS = 300

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const { t } = useLingui()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const timer = setTimeout(() => onChange(draft), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, value, onChange])
  return (
    <label {...stylex.props(list.search)}>
      <span aria-hidden="true" {...stylex.props(list.searchIcon)}>
        <Icon name="search" size={16} />
      </span>
      <input
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder={t`Name, email, phone or user ID`}
        aria-label={t`Search users`}
        {...stylex.props(list.searchInput)}
      />
    </label>
  )
}

function OptionMenu<T extends string>({
  label,
  value,
  options,
  labels,
  counts,
  onChange,
}: {
  label: string
  value: T | null
  options: readonly T[]
  labels: Record<T, MessageDescriptor>
  counts?: Partial<Record<T, number>>
  onChange: (value: T | null) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  return (
    <Dropdown
      ariaLabel={label}
      align="start"
      triggerStyle={list.filterButton}
      trigger={
        <>
          <span>{label}</span>
          {value ? <span {...stylex.props(list.filterValue)}>{i18n._(labels[value])}</span> : null}
          <Icon name="caret-down" size={12} />
        </>
      }
      items={[
        { key: 'any', label: t`Any`, checked: value === null, onSelect: () => onChange(null) },
        ...options.map((option) => {
          const count = counts?.[option]
          return {
            key: option,
            label:
              count === undefined
                ? i18n._(labels[option])
                : `${i18n._(labels[option])} (${i18n.number(count)})`,
            checked: value === option,
            onSelect: () => onChange(option),
          }
        }),
      ]}
    />
  )
}

function DateRange({
  legend,
  from,
  to,
  onChange,
}: {
  legend: ReactNode
  from: string | null
  to: string | null
  onChange: (from: string | null, to: string | null) => void
}): ReactNode {
  return (
    <fieldset {...stylex.props(rangeStyles.fieldset)}>
      <legend {...stylex.props(rangeStyles.legend)}>{legend}</legend>
      <div {...stylex.props(rangeStyles.row)}>
        <Field label={<Trans>From</Trans>}>
          <Input
            type="date"
            value={from ?? ''}
            onChange={(e) => onChange(e.currentTarget.value || null, to)}
          />
        </Field>
        <Field label={<Trans>To</Trans>}>
          <Input
            type="date"
            value={to ?? ''}
            onChange={(e) => onChange(from, e.currentTarget.value || null)}
          />
        </Field>
      </div>
    </fieldset>
  )
}

const rangeStyles = stylex.create({
  fieldset: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  legend: { padding: 0, fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.5rem' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
    gap: '0.75rem',
  },
  narrowOnly: {
    display: { default: 'flex', '@media (min-width: 64rem)': 'none' },
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
})

function MoreFiltersDialog({
  open,
  filters,
  counts,
  onClose,
  onApply,
}: {
  open: boolean
  filters: UserFilters
  counts: UserCounts | undefined
  onClose: () => void
  onApply: (filters: UserFilters) => void
}): ReactNode {
  const { t } = useLingui()
  const [draft, setDraft] = useState(filters)
  useEffect(() => {
    if (open) setDraft(filters)
  }, [open, filters])
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={<Trans>Filter users</Trans>}
      position={{ narrow: 'fullscreen', regular: 'side' }}
      size="md"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onApply({ ...EMPTY_USER_FILTERS, search: filters.search })}
          >
            <Trans>Clear filters</Trans>
          </Button>
          <Button onClick={() => onApply(draft)}>
            <Trans>Show users</Trans>
          </Button>
        </>
      }
    >
      <div {...stylex.props(rangeStyles.narrowOnly)}>
        <OptionMenu
          label={t`Status`}
          value={draft.status}
          options={USER_STATUS_OPTIONS}
          labels={STATUS_LABELS}
          counts={counts}
          onChange={(status) => setDraft({ ...draft, status })}
        />
        <OptionMenu
          label={t`Sign-in method`}
          value={draft.signInMethod}
          options={SIGN_IN_METHOD_OPTIONS}
          labels={METHOD_LABELS}
          onChange={(signInMethod) => setDraft({ ...draft, signInMethod })}
        />
      </div>
      <DateRange
        legend={<Trans>Last sign-in</Trans>}
        from={draft.lastSignInFrom}
        to={draft.lastSignInTo}
        onChange={(lastSignInFrom, lastSignInTo) =>
          setDraft({ ...draft, lastSignInFrom, lastSignInTo })
        }
      />
      <DateRange
        legend={<Trans>Created</Trans>}
        from={draft.createdFrom}
        to={draft.createdTo}
        onChange={(createdFrom, createdTo) => setDraft({ ...draft, createdFrom, createdTo })}
      />
      <Button
        variant="secondary"
        hidden={{ narrow: false, regular: false, sidebar: true }}
        onClick={() => globalThis.location.assign(exportHref(filters))}
      >
        <Trans>Export CSV</Trans>
      </Button>
    </Dialog>
  )
}

export type UserFilterBarProps = {
  filters: UserFilters
  counts: UserCounts | undefined
  onChange: (filters: UserFilters) => void
  onCreate: () => void
}

export function UserFilterBar({
  filters,
  counts,
  onChange,
  onCreate,
}: UserFilterBarProps): ReactNode {
  const { t } = useLingui()
  const [moreOpen, setMoreOpen] = useState(false)
  const active = activeFilterCount(filters)
  return (
    <div {...stylex.props(list.bar)}>
      <SearchBox value={filters.search} onChange={(search) => onChange({ ...filters, search })} />
      <span {...stylex.props(list.hideNarrow)}>
        <OptionMenu
          label={t`Status`}
          value={filters.status}
          options={USER_STATUS_OPTIONS}
          labels={STATUS_LABELS}
          counts={counts}
          onChange={(status) => onChange({ ...filters, status })}
        />
      </span>
      <span {...stylex.props(list.hideBelowSidebar)}>
        <OptionMenu
          label={t`Sign-in method`}
          value={filters.signInMethod}
          options={SIGN_IN_METHOD_OPTIONS}
          labels={METHOD_LABELS}
          onChange={(signInMethod) => onChange({ ...filters, signInMethod })}
        />
      </span>
      <Button variant="secondary" onClick={() => setMoreOpen(true)}>
        <Icon name="list-status" size={16} />
        <span {...stylex.props(list.hideBelowSidebar)}>
          <Trans>More filters</Trans>
        </span>
        <span {...stylex.props(list.onlyBelowSidebar)}>
          {active > 0 ? <Trans>Filters ({active})</Trans> : <Trans>Filters</Trans>}
        </span>
      </Button>
      <div {...stylex.props(list.barEnd)}>
        <Button
          variant="secondary"
          hidden={{ narrow: true, regular: true, sidebar: false }}
          onClick={() => globalThis.location.assign(exportHref(filters))}
        >
          <Trans>Export CSV</Trans>
        </Button>
        <Button onClick={onCreate}>
          <Icon name="plus" size={16} />
          <Trans>Create user…</Trans>
        </Button>
      </div>
      <MoreFiltersDialog
        open={moreOpen}
        filters={filters}
        counts={counts}
        onClose={() => setMoreOpen(false)}
        onApply={(next) => {
          setMoreOpen(false)
          onChange(next)
        }}
      />
    </div>
  )
}

export function UserFilterChips({
  filters,
  onChange,
}: {
  filters: UserFilters
  onChange: (filters: UserFilters) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const day = (value: string) => i18n.date(new Date(`${value}T00:00:00`), { dateStyle: 'medium' })
  const range = (from: string | null, to: string | null): string =>
    from && to
      ? t`${day(from)} to ${day(to)}`
      : from
        ? t`after ${day(from)}`
        : t`before ${day(to ?? '')}`
  const chips: { key: string; label: string; value: string; clear: Partial<UserFilters> }[] = []
  if (filters.status) {
    chips.push({
      key: 'status',
      label: t`Status`,
      value: i18n._(STATUS_LABELS[filters.status]),
      clear: { status: null },
    })
  }
  if (filters.signInMethod) {
    chips.push({
      key: 'method',
      label: t`Sign-in method`,
      value: i18n._(METHOD_LABELS[filters.signInMethod]),
      clear: { signInMethod: null },
    })
  }
  if (filters.lastSignInFrom || filters.lastSignInTo) {
    chips.push({
      key: 'last',
      label: t`Last sign-in`,
      value: range(filters.lastSignInFrom, filters.lastSignInTo),
      clear: { lastSignInFrom: null, lastSignInTo: null },
    })
  }
  if (filters.createdFrom || filters.createdTo) {
    chips.push({
      key: 'created',
      label: t`Created`,
      value: range(filters.createdFrom, filters.createdTo),
      clear: { createdFrom: null, createdTo: null },
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
        onClick={() => onChange({ ...EMPTY_USER_FILTERS, search: filters.search })}
        {...stylex.props(list.textButton)}
      >
        <Trans>Clear filters</Trans>
      </button>
    </>
  )
}
