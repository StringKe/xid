// 标签切换同一对象的不同视图。value 由页面写进 URL search param,后退可回;窄屏横向滚动,当前项滚入视口。

import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { media, size, text, weight } from '../../styles/scale.stylex'

export type TabItem = {
  value: string
  label: ReactNode
  count?: number
}

export type TabsProps = {
  items: readonly TabItem[]
  value: string
  onValueChange: (value: string) => void
  ariaLabel: string
  children?: ReactNode
}

const styles = stylex.create({
  list: {
    display: 'flex',
    gap: '1.5rem',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    overscrollBehaviorX: 'contain',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontFamily: tokens['--xid-font'],
  },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    flexShrink: 0,
    height: { default: size.rowDefault, [media.coarse]: size.touch },
    marginBlockEnd: '-1px',
    padding: 0,
    borderWidth: 0,
    borderBottomWidth: '2px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    backgroundColor: 'transparent',
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    fontFamily: 'inherit',
    fontSize: text.base,
    lineHeight: '1.125rem',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  active: {
    borderBottomColor: tokens['--xid-fg'],
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  count: {
    paddingBlock: '0.0625rem',
    paddingInline: '0.375rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    fontWeight: weight.regular,
    lineHeight: '1rem',
    fontVariantNumeric: 'tabular-nums',
  },
  panel: {
    paddingBlockStart: '1.5rem',
    outline: 'none',
  },
})

export function Tabs({ items, value, onValueChange, ariaLabel, children }: TabsProps): ReactNode {
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [value])

  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(String(next))}>
      <BaseTabs.List ref={listRef} aria-label={ariaLabel} {...stylex.props(styles.list)}>
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className={(state) => stylex.props(styles.tab, state.active && styles.active).className}
          >
            {item.label}
            {item.count !== undefined ? (
              <span {...stylex.props(styles.count)}>{item.count}</span>
            ) : null}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  )
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }): ReactNode {
  return (
    <BaseTabs.Panel value={value} {...stylex.props(styles.panel)}>
      {children}
    </BaseTabs.Panel>
  )
}
