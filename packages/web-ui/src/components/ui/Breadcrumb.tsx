import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { Icon } from './Icon'

export type BreadcrumbItem = {
  key: string
  label: ReactNode
  href?: string
}

export type BreadcrumbProps = {
  items: readonly BreadcrumbItem[]
}

const styles = stylex.create({
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.25rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
  item: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    minWidth: 0,
  },
  link: {
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    textDecoration: 'none',
  },
  current: {
    color: tokens['--xid-fg'],
  },
  separator: {
    display: 'inline-flex',
    color: tokens['--xid-faint-foreground'],
  },
})

export function Breadcrumb({ items }: BreadcrumbProps): ReactNode {
  const { t } = useLingui()
  return (
    <nav aria-label={t`Breadcrumb`}>
      <ol {...stylex.props(styles.list)}>
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          return (
            <li key={item.key} {...stylex.props(styles.item)}>
              {index > 0 ? (
                <span aria-hidden="true" {...stylex.props(styles.separator)}>
                  <Icon name="chevron-right" size={12} />
                </span>
              ) : null}
              {isLast || !item.href ? (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  {...stylex.props(isLast ? styles.current : styles.link)}
                >
                  {item.label}
                </span>
              ) : (
                <a href={item.href} {...stylex.props(styles.link)}>
                  {item.label}
                </a>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
