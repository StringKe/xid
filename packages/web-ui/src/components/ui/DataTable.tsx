// DataTable<T>:基于 @tanstack/react-table 的通用表格(useReactTable + getCoreRowModel + flexRender)。
// 三态:loading(骨架行) / empty(空态文案) / 数据。cursor 分页由外部 Pagination 配合,本组件只渲染当前页。
// 列定义用 TanStack ColumnDef<T>(header / cell 走 flexRender,可放 lingui <Trans>);宽度经 meta.width。
// 行点击经 onRowClick(键盘 Enter/Space 同触发,role=button + tabIndex)。
// 样式走 StyleX,引用主题 tokens(--xid-*);列宽与骨架透明度为运行时动态值。

import type { ReactNode } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type RowData,
} from '@tanstack/react-table'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Spinner } from './Spinner'

// 列宽放 ColumnDef.meta.width(TanStack meta 为开放扩展点),DataTable 读它设 <th> width。
// TanStack 的 ColumnMeta 是空 interface,这里经 interface 声明合并扩展(type 会触发 Duplicate identifier)。
declare module '@tanstack/react-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    width?: string
  }
}

export type DataTableProps<T> = {
  columns: ReadonlyArray<ColumnDef<T>>
  data: ReadonlyArray<T>
  // 稳定行键(default:索引)。
  getRowId?: (row: T, index: number) => string
  isLoading?: boolean
  // 空态文案(已本地化)。
  emptyMessage?: ReactNode
  // 行点击回调(给出则行可聚焦/键盘触发)。
  onRowClick?: (row: T) => void
  // 选中行判定(配合 onRowClick 的隐式选中给出可见选中态)。
  isRowSelected?: (row: T) => boolean
  // 表格说明(已本地化),渲染为 <caption>。
  caption?: string
}

const SKELETON_ROWS = 5

const styles = stylex.create({
  // 不做卡片包裹,避免表格外框和行间边框形成重复层级。
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
  // 表头用 mono microlabel,通过 border-strong 与普通行线建立层级。
  // hairline 邻接 >= 1.25rem:表头文本距底线 1.25rem,首行文本距底线 1.25rem
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
    // hairline 邻接 >= 1.25rem:单元格文本与上下行线各保 1.25rem
    paddingBlock: '1.25rem',
    paddingInline: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-fg'],
  },
  // 骨架条高度与真实 cell 内文字等高(0.875rem font * 1.5 lineHeight ≈ 1.3125rem, 防 CLS)
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
    // 按压即时反馈:pointer-down 立刻缩小,与 ui/Button 同口径。
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
  // 选中行:常驻 muted 底色 + 行首 2px 主色边,与 hover 瞬态区分。
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

export function DataTable<T>({
  columns,
  data,
  getRowId = defaultRowId,
  isLoading = false,
  emptyMessage,
  onRowClick,
  isRowSelected,
  caption,
}: DataTableProps<T>): ReactNode {
  const table = useReactTable<T>({
    data: data as T[],
    columns: columns as ColumnDef<T>[],
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
                  style={
                    header.column.columnDef.meta?.width
                      ? { width: header.column.columnDef.meta.width }
                      : undefined
                  }
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

type DataRowProps<T> = {
  row: Row<T>
  onRowClick?: (row: T) => void
  isRowSelected?: (row: T) => boolean
}

function DataRow<T>({ row, onRowClick, isRowSelected }: DataRowProps<T>): ReactNode {
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
