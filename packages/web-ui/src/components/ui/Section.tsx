// 区头与 DataTable 表头同 mono 签名;SectionRow 四 variant 捆绑列模板。
// control 经 cloneElement 注入 id/aria-describedby;split 元信息列仅宽屏可见。

import { cloneElement, isValidElement, useId } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type SectionProps = {
  label: ReactNode
  labelId?: string
  actions?: ReactNode
  children: ReactNode
}

export const SECTION_ROW_VARIANTS = ['item', 'control', 'static', 'split'] as const
export type SectionRowVariant = (typeof SECTION_ROW_VARIANTS)[number]

export type SectionRowProps = {
  label: ReactNode
  children?: ReactNode
  // control 变体接线到控件 aria-describedby。
  hint?: ReactNode
  action?: ReactNode
  variant?: SectionRowVariant
}

type ControlElementProps = {
  id?: string
  'aria-describedby'?: string
}

const styles = stylex.create({
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    // hairline 邻接文本 >= 1.25rem。
    paddingBottom: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border-strong'],
  },
  headLabel: {
    margin: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
  headActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    flexShrink: 0,
  },
  row: {
    display: 'grid',
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  gridLabel: {
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 40rem)': '11rem minmax(0, 1fr)',
    },
  },
  gridLabelAction: {
    gridTemplateColumns: {
      default: '1fr auto',
      '@media (min-width: 40rem)': '11rem minmax(0, 1fr) auto',
    },
  },
  gridSplit: {
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 40rem)': 'minmax(0, 1fr) minmax(0, 1fr)',
    },
  },
  gridSplitAction: {
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 40rem)': 'minmax(0, 1fr) minmax(0, 1fr) auto',
    },
  },
  rowItem: {
    alignItems: 'center',
    gap: {
      default: '0.5rem',
      '@media (min-width: 40rem)': '1.5rem',
    },
  },
  rowControl: {
    alignItems: 'start',
    gap: {
      default: '0.375rem',
      '@media (min-width: 40rem)': '1.5rem',
    },
  },
  rowStatic: {
    alignItems: 'baseline',
    gap: {
      default: '0.375rem',
      '@media (min-width: 40rem)': '1.5rem',
    },
  },
  rowSplit: {
    alignItems: 'center',
    gap: '0.5rem',
  },
  label: {
    fontSize: '0.8125rem',
    fontWeight: 550,
    lineHeight: 1.4,
    color: tokens['--xid-fg'],
  },
  // 与 2.5rem 高输入框首行文本对齐。
  labelControlOffset: {
    paddingBlockStart: {
      default: 0,
      '@media (min-width: 40rem)': '0.6875rem',
    },
  },
  contentBlock: {
    minWidth: 0,
  },
  contentControl: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    minWidth: 0,
  },
  // 窄屏由 label 主块内联呈现同等信息。
  contentSplit: {
    display: {
      default: 'none',
      '@media (min-width: 40rem)': 'flex',
    },
    flexDirection: 'column',
    gap: '0.1875rem',
  },
  hint: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
  },
})

export function Section({ label, labelId, actions, children }: SectionProps): ReactNode {
  const autoId = useId()
  const headId = labelId ?? autoId
  return (
    <section aria-labelledby={headId}>
      <div {...stylex.props(styles.head)}>
        <h2 id={headId} {...stylex.props(styles.headLabel)}>
          {label}
        </h2>
        {actions ? <div {...stylex.props(styles.headActions)}>{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

const LABEL_ROW_STYLES = {
  item: styles.rowItem,
  control: styles.rowControl,
  static: styles.rowStatic,
} as const

export function SectionRow({
  label,
  children,
  hint,
  action,
  variant = 'item',
}: SectionRowProps): ReactNode {
  const controlId = useId()
  const hintId = `${controlId}-hint`
  const hintNode = hint ? (
    <p id={hintId} {...stylex.props(styles.hint)}>
      {hint}
    </p>
  ) : null
  const hasAction = action != null

  if (variant === 'split') {
    return (
      <div
        {...stylex.props(
          styles.row,
          styles.rowSplit,
          hasAction ? styles.gridSplitAction : styles.gridSplit,
        )}
      >
        <div>{label}</div>
        <div {...stylex.props(styles.contentSplit)}>
          {children}
          {hintNode}
        </div>
        {action}
      </div>
    )
  }

  const isControl = variant === 'control'
  const control =
    isControl && isValidElement<ControlElementProps>(children)
      ? cloneElement(children, { id: controlId, 'aria-describedby': hint ? hintId : undefined })
      : children

  return (
    <div
      {...stylex.props(
        styles.row,
        LABEL_ROW_STYLES[variant],
        hasAction ? styles.gridLabelAction : styles.gridLabel,
      )}
    >
      {isControl ? (
        <label htmlFor={controlId} {...stylex.props(styles.label, styles.labelControlOffset)}>
          {label}
        </label>
      ) : (
        <span {...stylex.props(styles.label)}>{label}</span>
      )}
      <div {...stylex.props(isControl ? styles.contentControl : styles.contentBlock)}>
        {control}
        {hintNode}
      </div>
      {action}
    </div>
  )
}
