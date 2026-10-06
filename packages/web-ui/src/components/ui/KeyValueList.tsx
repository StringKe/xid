// 描述列表:容器宽度 >= 32rem 时键值并排,以下上下排(容器查询,不看视口)。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { container, text } from '../../styles/scale.stylex'

export type KeyValueItem = {
  key: string
  label: ReactNode
  value: ReactNode
  isCode?: boolean
}

export type KeyValueListProps = {
  items: readonly KeyValueItem[]
}

const styles = stylex.create({
  frame: {
    containerType: 'inline-size',
  },
  list: {
    margin: 0,
    fontFamily: tokens['--xid-font'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      [container.keyValueSideBySide]: '10rem minmax(0, 1fr)',
    },
    alignItems: { default: 'start', [container.keyValueSideBySide]: 'center' },
    columnGap: '1rem',
    rowGap: '0.125rem',
    minHeight: { default: 'auto', [container.keyValueSideBySide]: '2.5rem' },
    paddingBlock: { default: '0.625rem', [container.keyValueSideBySide]: '0.375rem' },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  term: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
  detail: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: '1.25rem',
    overflowWrap: 'anywhere',
  },
  code: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
  },
})

export function KeyValueList({ items }: KeyValueListProps): ReactNode {
  return (
    <div {...stylex.props(styles.frame)}>
      <dl {...stylex.props(styles.list)}>
        {items.map((item) => (
          <div key={item.key} {...stylex.props(styles.row)}>
            <dt {...stylex.props(styles.term)}>{item.label}</dt>
            <dd {...stylex.props(styles.detail, item.isCode && styles.code)}>{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
