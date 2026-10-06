// TanStack Table v9 只注册排序、分页(游标分页在外部,manual)、列可见性三个 feature。

import type { ReactNode } from 'react'
import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  createSortedRowModel,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  type ColumnDef,
} from '@tanstack/react-table'
import type { Responsive } from '../../responsive'
import { IdentityCell } from './IdentityCell'

export type DataTableRow = Record<string, unknown>

export type DataTableColumnMeta = {
  width?: string
  align?: 'start' | 'end'
  // 窄屏 priority 模式下 secondary 列隐藏,进详情看。
  priority?: 'primary' | 'secondary'
  hidden?: Responsive<boolean>
}

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    datetime: sortFn_datetime,
    basic: sortFn_basic,
  },
  columnMeta: {} as DataTableColumnMeta,
})

export type DataTableFeatures = typeof dataTableFeatures

export type DataTableColumnDef<T extends DataTableRow> = ColumnDef<DataTableFeatures, T>

export const DATA_TABLE_DENSITIES = ['compact', 'default', 'comfortable'] as const
export type DataTableDensity = (typeof DATA_TABLE_DENSITIES)[number]

export type IdentityColumnOptions<T extends DataTableRow> = {
  id: string
  header: ReactNode
  name: (row: T) => ReactNode
  secondary?: (row: T) => ReactNode
  secondaryIsCode?: (row: T) => boolean
  avatarName?: (row: T) => string
  width?: string
}

export function identityColumn<T extends DataTableRow>({
  id,
  header,
  name,
  secondary,
  secondaryIsCode,
  avatarName,
  width,
}: IdentityColumnOptions<T>): DataTableColumnDef<T> {
  return {
    id,
    header: () => header,
    cell: ({ row }) => (
      <IdentityCell
        name={name(row.original)}
        secondary={secondary?.(row.original)}
        secondaryIsCode={secondaryIsCode?.(row.original) ?? false}
        avatarName={avatarName?.(row.original)}
      />
    ),
    meta: { width, priority: 'primary' },
  }
}
