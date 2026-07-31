// ConsolePage:console / account 全宽页面的统一骨架。
// 一个页面 = ConsolePage(display 页头 + 可选 actions) + 若干 Section(底部 hairline 分节)。
// 版式全部来自 consoleShell(product-surface.stylex.ts),页面不再各自复制 gutter/hairline。
// lead 只写功能描述;org 上下文由壳层 switcher 承担,不在页头重复。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { consoleShell, page } from '../../styles/product-surface.stylex'

export type ConsolePageProps = {
  // 页面标题(已本地化)。
  title: ReactNode
  // 功能描述导语(已本地化)。
  lead?: ReactNode
  // 页头右侧主操作(如创建按钮)。
  actions?: ReactNode
  children: ReactNode
}

export function ConsolePage({ title, lead, actions, children }: ConsolePageProps): ReactNode {
  return (
    <div {...stylex.props(consoleShell.root)}>
      <header {...stylex.props(consoleShell.headerZone)}>
        <div {...stylex.props(consoleShell.headerRow)}>
          <div {...stylex.props(consoleShell.headerText)}>
            <h1 {...stylex.props(consoleShell.displayTitle)}>{title}</h1>
            {lead ? <p {...stylex.props(consoleShell.lead)}>{lead}</p> : null}
          </div>
          {actions ? <div {...stylex.props(consoleShell.headerActions)}>{actions}</div> : null}
        </div>
      </header>
      {children}
    </div>
  )
}

// ConsolePageNotice:页头与第一节之间的通栏消息位(query/mutation 反馈 Alert)。
export function ConsolePageNotice({ children }: { children: ReactNode }): ReactNode {
  return <div {...stylex.props(consoleShell.messageZone, consoleShell.noticeStack)}>{children}</div>
}

// ConsolePageToolbar:页头下的工具条(搜索/过滤/选择器),底部分隔 hairline。
export function ConsolePageToolbar({ children }: { children: ReactNode }): ReactNode {
  return <div {...stylex.props(consoleShell.toolbar)}>{children}</div>
}

export type ConsolePageSectionProps = {
  // 小节标题(mono microlabel,已本地化)。
  title?: ReactNode
  // 小节说明(已本地化)。
  description?: ReactNode
  // 小节行右侧操作。
  actions?: ReactNode
  children: ReactNode
}

export function ConsolePageSection({
  title,
  description,
  actions,
  children,
}: ConsolePageSectionProps): ReactNode {
  return (
    <section {...stylex.props(consoleShell.section, consoleShell.sectionStack)}>
      {title != null || actions != null ? (
        <div {...stylex.props(consoleShell.sectionHeadingRow)}>
          {title != null ? <h2 {...stylex.props(page.sectionLabel)}>{title}</h2> : null}
          {actions}
        </div>
      ) : null}
      {description ? <p {...stylex.props(consoleShell.sectionDescription)}>{description}</p> : null}
      {children}
    </section>
  )
}

export type ConsolePageSplitSectionProps = {
  // 左列小节标题(mono microlabel,已本地化)。
  title?: ReactNode
  // 左列小节说明(已本地化)。
  description?: ReactNode
  // 左列追加内容(如 selectorSummary)。
  meta?: ReactNode
  // 右列表单/控件。
  children: ReactNode
}

// ConsolePageSplitSection:5/7 双列节(创建/编辑表单的标准形态)。
export function ConsolePageSplitSection({
  title,
  description,
  meta,
  children,
}: ConsolePageSplitSectionProps): ReactNode {
  return (
    <section {...stylex.props(consoleShell.createSection)}>
      <div {...stylex.props(consoleShell.sectionMeta)}>
        {title != null ? <h2 {...stylex.props(page.sectionLabel)}>{title}</h2> : null}
        {description ? (
          <p {...stylex.props(consoleShell.sectionDescription)}>{description}</p>
        ) : null}
        {meta}
      </div>
      <div {...stylex.props(consoleShell.controls)}>{children}</div>
    </section>
  )
}
