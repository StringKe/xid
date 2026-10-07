// 可点选的方法 / 组织列表:plain 是「Try another way」里的分隔行,boxed 是带外框和右箭头的选择卡。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Icon, type IconName } from '@xid-kit/web-ui/ui/Icon'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

export type OptionItem = {
  key: string
  title: ReactNode
  description?: ReactNode
  icon?: IconName
  monogram?: string
  badge?: ReactNode
  onSelect: () => void
  disabled?: boolean
}

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  boxed: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    overflow: 'hidden',
  },
  item: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  itemBoxedLast: {
    borderBottomWidth: { default: '1px', ':last-child': 0 },
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    width: '100%',
    minHeight: '3.5rem',
    paddingBlock: '0.625rem',
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: tokens['--xid-fg'], ':hover': tokens['--xid-accent'] },
    fontFamily: tokens['--xid-font'],
    textAlign: 'start',
    cursor: 'pointer',
  },
  buttonBoxed: {
    paddingInline: '0.875rem',
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
  },
  buttonDisabled: {
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  icon: {
    display: 'inline-flex',
    justifyContent: 'center',
    flexShrink: 0,
    width: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
  tile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2rem',
    height: '2rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
    fontSize: text.xs,
    fontWeight: 600,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    minWidth: 0,
  },
  titleRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
    overflowWrap: 'anywhere',
  },
  description: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
    overflowWrap: 'anywhere',
  },
  badge: {
    flexShrink: 0,
    paddingBlock: '0.125rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    fontWeight: weight.medium,
    lineHeight: '1rem',
  },
  chevron: {
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
  },
})

export function OptionBadge({ children }: { children: ReactNode }): ReactNode {
  return <span {...stylex.props(styles.badge)}>{children}</span>
}

export function OptionList({
  items,
  variant = 'plain',
  label,
}: {
  items: readonly OptionItem[]
  variant?: 'plain' | 'boxed'
  label?: string
}): ReactNode {
  const boxed = variant === 'boxed'
  return (
    <ul aria-label={label} {...stylex.props(styles.list, boxed && styles.boxed)}>
      {items.map((item) => (
        <li key={item.key} {...stylex.props(styles.item, boxed && styles.itemBoxedLast)}>
          <button
            type="button"
            onClick={item.onSelect}
            disabled={item.disabled}
            {...stylex.props(
              styles.button,
              boxed && styles.buttonBoxed,
              item.disabled && styles.buttonDisabled,
            )}
          >
            {item.monogram ? (
              <span aria-hidden="true" {...stylex.props(styles.tile)}>
                {item.monogram}
              </span>
            ) : item.icon ? (
              <span aria-hidden="true" {...stylex.props(boxed ? styles.tile : styles.icon)}>
                <Icon name={item.icon} size={16} />
              </span>
            ) : null}
            <span {...stylex.props(styles.body)}>
              <span {...stylex.props(styles.titleRow)}>
                {item.title}
                {boxed && item.badge ? <OptionBadge>{item.badge}</OptionBadge> : null}
              </span>
              {item.description ? (
                <span {...stylex.props(styles.description)}>{item.description}</span>
              ) : null}
            </span>
            {!boxed && item.badge ? <OptionBadge>{item.badge}</OptionBadge> : null}
            {boxed ? (
              <span {...stylex.props(styles.chevron)}>
                <Icon name="chevron-right" size={16} />
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  )
}
