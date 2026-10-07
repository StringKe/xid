// 账户门户页面与分节骨架:标题、说明、右侧操作与分节内的行。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { surface } from './account-surface'

export type AccountPageProps = {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  // 标题前的元素(资料页的头像)。
  leading?: ReactNode
  // 标题上方的内容(待办提示、访客横幅、面包屑)。
  before?: ReactNode
  children: ReactNode
}

export function AccountPage({
  title,
  description,
  actions,
  leading,
  before,
  children,
}: AccountPageProps): ReactNode {
  return (
    <div {...stylex.props(surface.content)}>
      {before}
      <header {...stylex.props(surface.column, surface.pageHeader)}>
        <div {...stylex.props(surface.pageHeaderLead)}>
          {leading}
          <div {...stylex.props(surface.pageHeaderText)}>
            <h1 {...stylex.props(surface.pageTitle)}>{title}</h1>
            {description ? <p {...stylex.props(surface.pageLead)}>{description}</p> : null}
          </div>
        </div>
        {actions ? <div {...stylex.props(surface.sectionAction)}>{actions}</div> : null}
      </header>
      {children}
    </div>
  )
}

export type AccountSectionProps = {
  title: ReactNode
  // 标题旁的状态徽标(Two-step verification 的 On / Off)。
  badge?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children?: ReactNode
  labelledBy?: string
}

export function AccountSection({
  title,
  badge,
  description,
  action,
  children,
  labelledBy,
}: AccountSectionProps): ReactNode {
  return (
    <section aria-labelledby={labelledBy} {...stylex.props(surface.column, surface.section)}>
      <div {...stylex.props(surface.sectionHeader)}>
        <div {...stylex.props(surface.sectionHeaderText)}>
          <div {...stylex.props(surface.sectionTitleRow)}>
            <h2 id={labelledBy} {...stylex.props(surface.sectionTitle)}>
              {title}
            </h2>
            {badge}
          </div>
          {description ? <p {...stylex.props(surface.sectionDescription)}>{description}</p> : null}
        </div>
        {action ? <div {...stylex.props(surface.sectionAction)}>{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export type AccountRowProps = {
  icon?: ReactNode
  title: ReactNode
  badges?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}

export function AccountRow({ icon, title, badges, meta, actions }: AccountRowProps): ReactNode {
  return (
    <div {...stylex.props(surface.row)}>
      {icon}
      <div {...stylex.props(surface.rowMain)}>
        <div {...stylex.props(surface.rowTitleLine)}>
          <span {...stylex.props(surface.rowTitle)}>{title}</span>
          {badges}
        </div>
        {meta}
      </div>
      {actions ? <div {...stylex.props(surface.rowActions)}>{actions}</div> : null}
    </div>
  )
}

export function KeyRow({ label, children }: { label: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div {...stylex.props(surface.keyRow)}>
      <span {...stylex.props(surface.keyLabel)}>{label}</span>
      <span {...stylex.props(surface.rowValue)}>{children}</span>
    </div>
  )
}

export function RowMeta({ children }: { children: ReactNode }): ReactNode {
  return <p {...stylex.props(surface.rowMeta)}>{children}</p>
}
