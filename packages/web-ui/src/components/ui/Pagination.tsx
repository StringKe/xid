// 游标分页只有上一页 / 下一页;窄屏两个按钮平分整行并抬到 44px。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { media, text } from '../../styles/scale.stylex'
import { Button } from './Button'

export type PaginationProps = {
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  summary?: ReactNode
  isLoading?: boolean
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingBlockStart: '1rem',
    fontFamily: tokens['--xid-font'],
  },
  summary: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
    fontVariantNumeric: 'tabular-nums',
  },
  buttons: {
    display: 'flex',
    gap: '0.5rem',
    flexGrow: { default: 0, [media.narrow]: 1 },
  },
  button: {
    flexGrow: { default: 0, [media.narrow]: 1 },
  },
})

export function Pagination({
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  summary,
  isLoading = false,
}: PaginationProps): ReactNode {
  const { t } = useLingui()
  return (
    <nav aria-label={t`Pagination`} {...stylex.props(styles.root)}>
      {summary ? <p {...stylex.props(styles.summary)}>{summary}</p> : null}
      <div {...stylex.props(styles.buttons)}>
        <span {...stylex.props(styles.button)}>
          <Button
            variant="secondary"
            fullWidth
            disabled={!hasPrevious || isLoading}
            onClick={onPrevious}
          >
            <Trans>Previous</Trans>
          </Button>
        </span>
        <span {...stylex.props(styles.button)}>
          <Button variant="secondary" fullWidth disabled={!hasNext || isLoading} onClick={onNext}>
            <Trans>Next</Trans>
          </Button>
        </span>
      </div>
    </nav>
  )
}
