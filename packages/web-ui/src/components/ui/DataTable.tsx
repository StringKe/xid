// @tanstack/react-table v9 将 useReactTable 迁到 /legacy;本组件走 legacy。cursor 分页在外部。

import type { ReactNode } from 'react'
import { flexRender } from '@tanstack/react-table'
import {
  getCoreRowModel,
  useLegacyTable,
  type LegacyColumnDef,
  type LegacyRow,
} from '@tanstack/react-table/legacy'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Spinner } from './Spinner'

// v9 RowData 可含 array;业务行一律对象。
export type DataTableRow = Record<string, unknown>

export type DataTableColumnDef<T extends DataTableRow> = LegacyColumnDef<T>

type ColumnWidthMeta = {
  width?: string
}

export type DataTableProps<T extends DataTableRow> = {
  columns: ReadonlyArray<DataTableColumnDef<T>>
  data: ReadonlyArray<T>
  getRowId?: (row: T, index: number) => string
  isLoading?: boolean
  emptyMessage?: ReactNode
  onRowClick?: (row: T) => void
  isRowSelected?: (row: T) => boolean
  caption?: string
}

const SKELETON_ROWS = 5

const styles = stylex.create({
  // 不做卡片包裹,避免外框与行间边框重复层级。
  scroll: {
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: tokens['--xid-font'],
  },
  caption: {
    captionSide: 'top',
    textAlign: 'left',
    paddingBlock: '0.5rem',
    paddingInline: '0.75rem',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
  },
  // mono microlabel + border-strong;hairline 邻接文本 >= 1.25rem。
  th: {
    paddingBlockStart: '0.875rem',
    paddingBlockEnd: '1.25rem',
    paddingInline: '0.75rem',
    textAlign: 'left',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
    backgroundColor: 'transparent',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border-strong'],
    whiteSpace: 'nowrap',
  },
  cell: {
    paddingBlock: '1.25rem',
    paddingInline: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-fg'],
  },
  // 与 cell 文字等高,防 CLS。
  skeletonBar: {
    display: 'block',
    height: '1.3125rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-border'],
    width: '60%',
  },
  emptyCell: {
    paddingBlock: '2rem',
    paddingInline: '0.75rem',
    textAlign: 'center',
    color: tokens['--xid-muted-foreground'],
  },
  clickableRow: {
    cursor: 'pointer',
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'background-color, transform',
    transitionDuration: '120ms',
    transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
    backgroundColor: {
      default: 'transparent',
      ':hover': tokens['--xid-muted'],
      ':focus-visible': tokens['--xid-muted'],
    },
  },
  // 常驻选中态,与 hover 瞬态区分。
  selectedRow: {
    backgroundColor: tokens['--xid-muted'],
    boxShadow: `inset 2px 0 0 ${tokens['--xid-primary']}`,
  },
  loadingFooter: {
    display: 'flex',
    justifyContent: 'center',
    padding: '0.875rem',
  },
})

function defaultRowId<T>(_row: T, index: number): string {
  return String(index)
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
}: DataTableProps<T>): ReactNode {
  const table = useLegacyTable<T>({
    data: data as T[],
    columns: columns as DataTableColumnDef<T>[],
    getRowId,
    getCoreRowModel: getCoreRowModel(),
  })

  const headerGroups = table.getHeaderGroups()
  const colCount = table.getAllLeafColumns().length
  const rows = table.getRowModel().rows

  return (
    <div {...stylex.props(styles.scroll)}>
      <table {...stylex.props(styles.table)}>
        {caption ? <caption {...stylex.props(styles.caption)}>{caption}</caption> : null}
        <thead>
          {headerGroups.map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  {...stylex.props(styles.th)}
                  style={(() => {
                    const width = (header.column.columnDef.meta as ColumnWidthMeta | undefined)
                      ?.width
                    return width ? { width } : undefined
                  })()}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {isLoading ? (
            <SkeletonRows colCount={colCount} />
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
                onRowClick={onRowClick}
                isRowSelected={isRowSelected}
              />
            ))
          )}
        </tbody>
      </table>
      {isLoading ? (
        <div role="status" aria-live="polite" {...stylex.props(styles.loadingFooter)}>
          <Spinner size={20} />
        </div>
      ) : null}
    </div>
  )
}

function SkeletonRows({ colCount }: { colCount: number }): ReactNode {
  return (
    <>
      {Array.from({ length: SKELETON_ROWS }).map((_unused, rowIdx) => (
        <tr key={`skeleton-${rowIdx}`} aria-hidden="true">
          {Array.from({ length: colCount }).map((_cell, cellIdx) => (
            <td key={`skeleton-${rowIdx}-${cellIdx}`} {...stylex.props(styles.cell)}>
              <span {...stylex.props(styles.skeletonBar)} style={{ opacity: 1 - rowIdx * 0.15 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

type DataRowProps<T extends DataTableRow> = {
  row: LegacyRow<T>
  onRowClick?: (row: T) => void
  isRowSelected?: (row: T) => boolean
}

function DataRow<T extends DataTableRow>({
  row,
  onRowClick,
  isRowSelected,
}: DataRowProps<T>): ReactNode {
  const clickable = Boolean(onRowClick)
  const selected = isRowSelected?.(row.original) ?? false

  return (
    <tr
      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? 'button' : undefined}
      aria-selected={clickable ? selected : undefined}
      onKeyDown={
        onRowClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onRowClick(row.original)
              }
            }
          : undefined
      }
      {...stylex.props(clickable && styles.clickableRow, selected && styles.selectedRow)}
    >
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} {...stylex.props(styles.cell)}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  )
}
