// 细线表格:表头 sticky、行高三档(默认 40)、窄屏两种形态:priority 隐藏次要列,scroll 横向滚动并固定首列。
// 不把 <table> 改成 block/grid,保留表格语义。

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  flexRender,
  useTable,
  type Header,
  type Row,
  type SortingState,
} from '@tanstack/react-table'
import * as stylex from '@stylexjs/stylex'
import { mergeClassNames } from '../../class-name'
import { page } from '../../styles/product-surface.stylex'
import { Icon } from './Icon'
import { responsiveHiddenClassName } from './responsive-hidden'
import { Skeleton } from './Skeleton'
import { tableStyles as styles } from './data-table-styles'
import {
  dataTableFeatures,
  type DataTableColumnDef,
  type DataTableColumnMeta,
  type DataTableDensity,
  type DataTableFeatures,
  type DataTableRow,
} from './data-table-model'

export type { DataTableColumnDef, DataTableColumnMeta, DataTableDensity, DataTableRow }
export { DATA_TABLE_DENSITIES, dataTableFeatures, identityColumn } from './data-table-model'

export type DataTableProps<T extends DataTableRow> = {
  columns: ReadonlyArray<DataTableColumnDef<T>>
  data: ReadonlyArray<T>
  getRowId?: (row: T, index: number) => string
  isLoading?: boolean
  emptyMessage?: ReactNode
  onRowClick?: (row: T) => void
  isRowSelected?: (row: T) => boolean
  caption?: string
  captionDisplay?: 'visible' | 'hidden'
  density?: DataTableDensity
  narrowMode?: 'priority' | 'scroll'
  columnVisibility?: Record<string, boolean>
}

const SKELETON_ROWS = 5

function defaultRowId<T>(_row: T, index: number): string {
  return String(index)
}

const DENSITY_STYLES = {
  compact: styles.rowCompact,
  default: styles.rowDefault,
  comfortable: styles.rowComfortable,
} as const

function cellClassName(
  meta: DataTableColumnMeta | undefined,
  narrowMode: 'priority' | 'scroll',
): string | undefined {
  const hidden =
    meta?.hidden ??
    (narrowMode === 'priority' && meta?.priority === 'secondary' ? { narrow: true } : undefined)
  return responsiveHiddenClassName(hidden)
}

export function DataTable<T extends DataTableRow>({
  columns,
  data,
  getRowId = defaultRowId,
  isLoading = false,
  emptyMessage,
  onRowClick,
  isRowSelected,
  caption,
  captionDisplay = 'visible',
  density = 'default',
  narrowMode = 'scroll',
  columnVisibility,
}: DataTableProps<T>): ReactNode {
  const [sorting, setSorting] = useState<SortingState>([])
  const table = useTable<DataTableFeatures, T>({
    features: dataTableFeatures,
    data: data as T[],
    columns: columns as DataTableColumnDef<T>[],
    getRowId,
    manualPagination: true,
    state: { sorting, ...(columnVisibility ? { columnVisibility } : {}) },
    onSortingChange: setSorting,
  })

  const headerGroups = table.getHeaderGroups()
  const colCount = table.getVisibleLeafColumns().length
  const rows = table.getRowModel().rows
  const isScroll = narrowMode === 'scroll'

  return (
    <div
      {...stylex.props(styles.frame, isScroll && styles.scroll)}
      role={isScroll && caption ? 'region' : undefined}
      aria-label={isScroll ? caption : undefined}
      tabIndex={isScroll && caption ? 0 : undefined}
    >
      <table {...stylex.props(styles.table)} aria-busy={isLoading || undefined}>
        {caption ? (
          <caption
            {...stylex.props(captionDisplay === 'hidden' ? page.visuallyHidden : styles.caption)}
          >
            {caption}
          </caption>
        ) : null}
        <thead>
          {headerGroups.map((group) => (
            <tr key={group.id}>
              {group.headers.map((header, index) => (
                <HeaderCell
                  key={header.id}
                  header={header}
                  isStickyFirst={isScroll && index === 0}
                  narrowMode={narrowMode}
                />
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {isLoading ? (
            <SkeletonRows colCount={colCount} density={density} />
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} {...stylex.props(styles.emptyCell)}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <DataRow
                key={row.id}
                row={row}
                density={density}
                narrowMode={narrowMode}
                onRowClick={onRowClick}
                isRowSelected={isRowSelected}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

type HeaderCellProps<T extends DataTableRow> = {
  header: Header<DataTableFeatures, T, unknown>
  isStickyFirst: boolean
  narrowMode: 'priority' | 'scroll'
}

function HeaderCell<T extends DataTableRow>({
  header,
  isStickyFirst,
  narrowMode,
}: HeaderCellProps<T>): ReactNode {
  const meta = header.column.columnDef.meta
  const canSort = header.column.getCanSort()
  const sorted = header.column.getIsSorted()
  const props = stylex.props(
    styles.th,
    meta?.align === 'end' && styles.alignEnd,
    isStickyFirst && styles.stickyFirst,
  )
  const content = header.isPlaceholder
    ? null
    : flexRender(header.column.columnDef.header, header.getContext())
  return (
    <th
      scope="col"
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      className={mergeClassNames(props.className, cellClassName(meta, narrowMode))}
      style={{ ...props.style, ...(meta?.width ? { width: meta.width } : {}) }}
    >
      {canSort ? (
        <button
          type="button"
          onClick={header.column.getToggleSortingHandler()}
          {...stylex.props(styles.sortButton)}
        >
          {content}
          {sorted ? <Icon name={sorted === 'asc' ? 'caret-up' : 'caret-down'} size={12} /> : null}
        </button>
      ) : (
        content
      )}
    </th>
  )
}

function SkeletonRows({
  colCount,
  density,
}: {
  colCount: number
  density: DataTableDensity
}): ReactNode {
  return Array.from({ length: SKELETON_ROWS }).map((_unused, rowIdx) => (
    <tr key={`skeleton-${rowIdx}`} aria-hidden="true" {...stylex.props(DENSITY_STYLES[density])}>
      {Array.from({ length: colCount }).map((_cell, cellIdx) => (
        <td key={`skeleton-${rowIdx}-${cellIdx}`} {...stylex.props(styles.cell)}>
          <Skeleton width={cellIdx === 0 ? '60%' : '40%'} height="0.625rem" />
        </td>
      ))}
    </tr>
  ))
}

type DataRowProps<T extends DataTableRow> = {
  row: Row<DataTableFeatures, T>
  density: DataTableDensity
  narrowMode: 'priority' | 'scroll'
  onRowClick?: (row: T) => void
  isRowSelected?: (row: T) => boolean
}

function DataRow<T extends DataTableRow>({
  row,
  density,
  narrowMode,
  onRowClick,
  isRowSelected,
}: DataRowProps<T>): ReactNode {
  const clickable = Boolean(onRowClick)
  const selected = isRowSelected?.(row.original) ?? false
  const isScroll = narrowMode === 'scroll'

  return (
    <tr
      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-selected={clickable ? selected : undefined}
      onKeyDown={
        onRowClick
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              if (event.target !== event.currentTarget) return
              event.preventDefault()
              onRowClick(row.original)
            }
          : undefined
      }
      {...stylex.props(
        styles.row,
        DENSITY_STYLES[density],
        clickable && styles.clickableRow,
        selected && styles.selectedRow,
      )}
    >
      {row.getVisibleCells().map((cell, index) => {
        const meta = cell.column.columnDef.meta
        const props = stylex.props(
          styles.cell,
          meta?.align === 'end' && styles.alignEnd,
          isScroll && index === 0 && styles.stickyFirst,
        )
        return (
          <td
            key={cell.id}
            className={mergeClassNames(props.className, cellClassName(meta, narrowMode))}
            style={props.style}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        )
      })}
    </tr>
  )
}
