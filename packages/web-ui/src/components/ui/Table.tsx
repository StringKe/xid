// 旧 TableColumn(key/header/render) 兼容层;新页面直接用 DataTable + ColumnDef。

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { DataTable, type DataTableColumnDef, type DataTableRow } from './DataTable'

export type TableColumn<T extends DataTableRow> = {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: string
}

export type TableProps<T extends DataTableRow> = {
  columns: ReadonlyArray<TableColumn<T>>
  rows: ReadonlyArray<T>
  getRowKey: (row: T) => string
  isLoading?: boolean
  emptyMessage?: ReactNode
  onRowClick?: (row: T) => void
  caption?: string
}

function toColumnDefs<T extends DataTableRow>(
  columns: ReadonlyArray<TableColumn<T>>,
): DataTableColumnDef<T>[] {
  return columns.map((col) => ({
    id: col.key,
    header: () => col.header,
    cell: ({ row }) => col.render(row.original),
    meta: { width: col.width },
  }))
}

export function Table<T extends DataTableRow>({
  columns,
  rows,
  getRowKey,
  isLoading = false,
  emptyMessage,
  onRowClick,
  caption,
}: TableProps<T>): ReactNode {
  const columnDefs = useMemo(() => toColumnDefs(columns), [columns])

  return (
    <DataTable
      columns={columnDefs}
      data={rows}
      getRowId={(row) => getRowKey(row)}
      isLoading={isLoading}
      emptyMessage={emptyMessage}
      onRowClick={onRowClick}
      caption={caption}
    />
  )
}
