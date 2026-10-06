// cursor 分页的「加载更多」:把下一页追加到已加载的列表;逐页翻看用 Pagination。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from './Button'

export type LoadMoreQuery = {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}

export type LoadMoreProps = {
  query: LoadMoreQuery
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

export function LoadMore({ query, loadMoreLabel }: LoadMoreProps): ReactNode {
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
