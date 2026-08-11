import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./Spinner', () => ({
  Spinner: ({ label }: { label?: string }): ReactNode => (
    <span role="status">{label ?? 'Loading'}</span>
  ),
}))

import { DataTable } from './DataTable'
import { Table } from './Table'

type Row = {
  id: string
  email: string
  name: string
}

const rows: Row[] = [{ id: 'user_1', email: 'chen@example.com', name: 'Chen' }]

describe('DataTable', () => {
  it('renders columns without width meta without undefined style values', () => {
    const columns: ColumnDef<Row>[] = [
      {
        accessorKey: 'email',
        header: 'Email',
        cell: ({ row }) => row.original.email,
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => row.original.name,
      },
    ]

    const html = renderToStaticMarkup(
      <DataTable columns={columns} data={rows} getRowId={(row) => row.id} emptyMessage="Empty" />,
    )

    expect(html).toContain('<table')
    expect(html).toContain('chen@example.com')
    expect(html).not.toContain('undefined')
  })

  it('renders Table columns without width without undefined style values', () => {
    const html = renderToStaticMarkup(
      <Table
        columns={[
          { key: 'email', header: 'Email', render: (row) => row.email },
          { key: 'name', header: 'Name', render: (row) => row.name },
        ]}
        rows={rows}
        getRowKey={(row) => row.id}
        emptyMessage="Empty"
      />,
    )

    expect(html).toContain('<table')
    expect(html).toContain('chen@example.com')
    expect(html).not.toContain('undefined')
  })
})
