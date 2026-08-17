// console/account 全宽骨架;lead 只写功能,org 上下文由壳层 switcher 承担。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { consoleShell, page } from '../../styles/product-surface.stylex'

export type ConsolePageProps = {
  title: ReactNode
  lead?: ReactNode
  actions?: ReactNode
  // wide 豁免 72rem 内容列上限,DataTable 全宽表格页使用。
  wide?: boolean
  children: ReactNode
}

export function ConsolePage({ title, lead, actions, wide, children }: ConsolePageProps): ReactNode {
  return (
    <div {...stylex.props(consoleShell.root)}>
      <div {...stylex.props(consoleShell.contentCap, wide && consoleShell.contentCapWide)}>
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
    </div>
  )
}

export function ConsolePageNotice({ children }: { children: ReactNode }): ReactNode {
  return <div {...stylex.props(consoleShell.messageZone, consoleShell.noticeStack)}>{children}</div>
}

export function ConsolePageToolbar({ children }: { children: ReactNode }): ReactNode {
  return <div {...stylex.props(consoleShell.toolbar)}>{children}</div>
}

export type ConsolePageSectionProps = {
  title?: ReactNode
  description?: ReactNode
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
  title?: ReactNode
  description?: ReactNode
  meta?: ReactNode
  children: ReactNode
}

// 5/7 双列节:创建/编辑表单标准形态。
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
