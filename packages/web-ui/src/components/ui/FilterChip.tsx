// 已应用的筛选条件:「字段 值 ×」,每个条件可单独删除;条件本身由页面写进 URL。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { media, size, text, weight } from '../../styles/scale.stylex'
import { Icon } from './Icon'

export type FilterChipProps = {
  label: ReactNode
  value: ReactNode
  removeLabel: string
  onRemove: () => void
}

const styles = stylex.create({
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    minHeight: { default: '1.625rem', [media.coarse]: '2rem' },
    paddingInlineStart: '0.625rem',
    paddingInlineEnd: '0.25rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
    whiteSpace: 'nowrap',
  },
  label: {
    color: tokens['--xid-muted-foreground'],
  },
  value: {
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  remove: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: { default: '1.5rem', [media.coarse]: size.touch },
    height: { default: '1.5rem', [media.coarse]: size.touch },
    marginBlock: { default: 0, [media.coarse]: '-0.375rem' },
    padding: 0,
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-border'] },
    color: tokens['--xid-muted-foreground'],
    cursor: 'pointer',
  },
})

export function FilterChip({ label, value, removeLabel, onRemove }: FilterChipProps): ReactNode {
  return (
    <span {...stylex.props(styles.chip)}>
      <span {...stylex.props(styles.label)}>{label}</span>
      <span {...stylex.props(styles.value)}>{value}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        {...stylex.props(styles.remove)}
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  )
}
