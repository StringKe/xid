// Table:DataTable<T>(@tanstack/react-table)的兼容封装,保留旧 TableColumn 形态(key/header/render/width)。
// 把 render(row) 形态的列适配为 TanStack ColumnDef(cell 经 row.original 调 render),供既有页面零改动复用。
// 新页面优先直接用 DataTable + ColumnDef。三态/分页/a11y 全部下沉到 DataTable。

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { DataTable } from './DataTable'

export type TableColumn<T> = {
  key: string
  header: ReactNode
  // 渲染单元格内容;row 已类型化。
  render: (row: T) => ReactNode
  // 列宽(CSS width 值)。
  width?: string
}

export type TableProps<T> = {
  columns: ReadonlyArray<TableColumn<T>>
  rows: ReadonlyArray<T>
  getRowKey: (row: T) => string
  isLoading?: boolean
  // 空态文案(已本地化)。
  emptyMessage?: ReactNode
  // 行点击回调。
  onRowClick?: (row: T) => void
  caption?: string
}

function toColumnDefs<T>(columns: ReadonlyArray<TableColumn<T>>): ColumnDef<T>[] {
  return columns.map((col) => ({
    id: col.key,
    header: () => col.header,
    cell: ({ row }) => col.render(row.original),
    meta: { width: col.width },
  }))
}

export function Table<T>({
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
