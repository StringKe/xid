// cursor 分页无法随机访问,「加载更多」把下一页追加到已加载的列表。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from './Button'

export type PaginationQuery = {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}

export type PaginationProps = {
  query: PaginationQuery
  loadMoreLabel: ReactNode
}

const styles = stylex.create({
  row: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '0.75rem',
    paddingInline: 0,
  },
})

export function Pagination({ query, loadMoreLabel }: PaginationProps): ReactNode {
  if (!query.hasNextPage) return null

  return (
    <div {...stylex.props(styles.row)}>
      <Button
        variant="secondary"
        isLoading={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        {loadMoreLabel}
      </Button>
    </div>
  )
}
