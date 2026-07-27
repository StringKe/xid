// Section / SectionRow:account/console 信息密度型分区的共享骨架。
// Section = mono microlabel 区头(border-strong 底线,与 DataTable 表头同签名)+ 可选右侧操作区;
// SectionRow = paddingBlock 1.25rem + 1px 行间线的行式 grid,四种 variant 捆绑列模板/对齐/间距:
//   - item(默认): 11rem 字段名列 + 内容列(+ action auto 列),居中对齐 -- 条目列表行
//   - control:    同列模板,label 接线单一控件 child(口径对齐 ui/Field),label 下移对齐输入框首行
//   - static:     同列模板,baseline 对齐 -- 只读静态值行
//   - split:      两列等分(label=条目主块,children=仅宽屏可见的元信息列)+ action auto 列
// 文案零持有:label/hint/action 全由调用方传入(已本地化)。

import { cloneElement, isValidElement, useId } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type SectionProps = {
  // 区头文本(已本地化),渲染为 h2 并经 aria-labelledby 关联 section。
  label: ReactNode
  // 外部需要稳定区头 id 时传入;缺省自动生成。
  labelId?: string
  // 区头右侧操作区(按钮等),与 microlabel 同行贴右。
  actions?: ReactNode
  children: ReactNode
}

export const SECTION_ROW_VARIANTS = ['item', 'control', 'static', 'split'] as const
export type SectionRowVariant = (typeof SECTION_ROW_VARIANTS)[number]

export type SectionRowProps = {
  // 左列:字段名(item/control/static)或条目主块(split,页面自带排版)。
  label: ReactNode
  // 内容列;split 变体下为仅宽屏可见的元信息列。
  children?: ReactNode
  // muted 说明,渲染在内容列底部;control 变体接线到控件 aria-describedby。
  hint?: ReactNode
  // 右侧操作列,提供时行尾加 auto 第三列;多个操作时调用方自带 flex 容器。
  action?: ReactNode
  variant?: SectionRowVariant
}

// control 变体经 cloneElement 注入的控件属性(Input/select/textarea 均满足)。
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
    // hairline 邻接 >= 1.25rem:label 文本距底线 1.25rem;线下方首行收紧为二级口径 >= 0.875rem(调用方行内 paddingBlockStart)
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
    // hairline 邻接 >= 1.25rem:行文本与上下 hairline 各保 1.25rem 间距
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  // 列模板:label 系(11rem 字段名列)与 split 系(两列等分);窄屏(<40rem)堆叠。
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
  // 对齐 + 间距按 variant 捆绑(与抽取前各页数值一致)。
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
  // 控件行 label 下移,与 2.5rem 高输入框的首行文本对齐。
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
  // split 的元信息列:仅宽屏可见,窄屏由 label 主块内联呈现同等信息。
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
