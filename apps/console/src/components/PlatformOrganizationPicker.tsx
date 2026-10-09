// 平台表单按名称或 slug 选择顶层组织,提交值是组织 ID,不要求管理员手抄 ID。
// 组织多于一页时才显示筛选输入框。

import { Trans, useLingui } from '@lingui/react/macro'
import { useDeferredValue, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Field, Input, Select } from '@xid-kit/web-ui/ui'
import { useOrganizationLabel } from '@xid-kit/web-ui/display-names'
import { usePlatformOrganizationsList } from '../routes/platform/queries'

export type PlatformOrganizationOption = {
  value: string
  label: string
}

export type PlatformOrganizationPickerProps = {
  label: ReactNode
  value: string
  onChange: (organizationId: string) => void
  emptyOption?: string
  extraOptions?: readonly PlatformOrganizationOption[]
  required?: boolean
  error?: ReactNode
}

const styles = stylex.create({
  root: {
    display: 'grid',
    gap: '0.5rem',
  },
})

export function PlatformOrganizationPicker({
  label,
  value,
  onChange,
  emptyOption,
  extraOptions = [],
  required = false,
  error,
}: PlatformOrganizationPickerProps): ReactNode {
  const { t } = useLingui()
  const organizationLabel = useOrganizationLabel()
  const [search, setSearch] = useState('')
  const [selectedLabel, setSelectedLabel] = useState<PlatformOrganizationOption | null>(null)
  const query = useDeferredValue(search.trim())
  const organizations = usePlatformOrganizationsList(query)

  const options: PlatformOrganizationOption[] = [
    ...extraOptions,
    ...(organizations.data?.data ?? []).map((organization) => ({
      value: organization.id,
      label: `${organizationLabel(organization)} (${organization.slug})`,
    })),
  ]
  if (value && !options.some((option) => option.value === value)) {
    options.unshift(selectedLabel?.value === value ? selectedLabel : { value, label: value })
  }

  function select(next: string): void {
    setSelectedLabel(options.find((option) => option.value === next) ?? null)
    onChange(next)
  }

  return (
    <div {...stylex.props(styles.root)}>
      <Field label={label} required={required} error={error}>
        <Select value={value} onChange={(event) => select(event.currentTarget.value)}>
          {emptyOption === undefined ? (
            <option disabled value="">
              {t`Select organization`}
            </option>
          ) : (
            <option value="">{emptyOption}</option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {organizations.hasNextPage || search !== '' ? (
        <Field
          hint={
            organizations.hasNextPage ? (
              <Trans>Only the first matches are listed. Refine the search to narrow them.</Trans>
            ) : undefined
          }
        >
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t`Filter organizations by name or slug`}
            aria-label={t`Filter organizations by name or slug`}
          />
        </Field>
      ) : null}
    </div>
  )
}
