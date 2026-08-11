// cursor 分页无法随机访问,仅"加载更多"。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from './Button'

export type PaginationProps = {
  nextCursor: string | null
  isLoading?: boolean
  loadMoreLabel: ReactNode
  onLoadMore: (cursor: string) => void
}

const styles = stylex.create({
  row: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '0.75rem',
    paddingInline: 0,
  },
})

export function Pagination({
  nextCursor,
  isLoading = false,
  loadMoreLabel,
  onLoadMore,
}: PaginationProps): ReactNode {
  if (!nextCursor) return null

  return (
    <div {...stylex.props(styles.row)}>
      <Button variant="secondary" isLoading={isLoading} onClick={() => onLoadMore(nextCursor)}>
        {loadMoreLabel}
      </Button>
    </div>
  )
}
