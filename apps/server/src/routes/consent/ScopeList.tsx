// scope 权限列表与 authorization_details 资源访问列表。

import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import type { ConsentParams } from './index'

// 标准 scope 描述的本地化标签(worker consent.ts 只产出英文回退,多语言在此渲染;
// 与 lib/enum-labels.tsx 同一模式)。自定义 scope 无映射回退 server description。
const SCOPE_DESCRIPTION_LABELS: Record<string, MessageDescriptor> = {
  openid: msg`Verify your identity`,
  profile: msg`Access your basic profile information`,
  email: msg`Access your email address`,
  address: msg`Access your physical address`,
  phone: msg`Access your phone number`,
  offline_access: msg`Maintain access while you are offline`,
}

// 行式列表:无 listStyle / padding,行间 hairline。
const styles = stylex.create({
  permissionSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
  },
  sectionLabel: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
    // hairline 邻接 >= 1.25rem:label 文本距列表顶线 1.25rem(与 ui/Section 区头同口径)
    marginBottom: '1.25rem',
  },
  rowList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  rowItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    // hairline 邻接 >= 1.25rem:行文本与上下行线各保 1.25rem
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  rowItemText: {
    fontSize: '0.875rem',
    lineHeight: 1.45,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  rowItemMeta: {
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    wordBreak: 'break-word',
  },
})

type ScopeListProps = {
  scopes: readonly { name: string; description: string }[]
}

type ScopeItemProps = {
  scope: { name: string; description: string }
}

function ScopeItem({ scope }: ScopeItemProps): ReactNode {
  const { i18n } = useLingui()
  const descriptor = SCOPE_DESCRIPTION_LABELS[scope.name]
  return (
    <li {...stylex.props(styles.rowItem)}>
      <span {...stylex.props(styles.rowItemText)}>
        {descriptor ? i18n._(descriptor) : scope.description}
      </span>
      <span {...stylex.props(styles.rowItemMeta)}>{scope.name}</span>
    </li>
  )
}

export function ScopeList({ scopes }: ScopeListProps): ReactNode {
  const { t } = useLingui()
  if (scopes.length === 0) return null

  return (
    <section aria-label={t`Requested permissions`} {...stylex.props(styles.permissionSection)}>
      <p {...stylex.props(styles.sectionLabel)}>
        <Trans>Permissions requested</Trans>
      </p>
      <ul {...stylex.props(styles.rowList)}>
        {scopes.map((scope) => (
          <ScopeItem key={scope.name} scope={scope} />
        ))}
      </ul>
    </section>
  )
}

type AuthorizationDetailsListProps = {
  details: ConsentParams['authorizationDetails']
}

type AuthorizationDetailsItemProps = {
  detail: ConsentParams['authorizationDetails'][number]
}

function AuthorizationDetailsItem({ detail }: AuthorizationDetailsItemProps): ReactNode {
  return (
    <li {...stylex.props(styles.rowItem)}>
      <span {...stylex.props(styles.rowItemText)}>
        <Trans>Access protected resources</Trans>
      </span>
      <span {...stylex.props(styles.rowItemMeta)}>
        <Trans>Resources: {detail.locations.join(', ')}</Trans>
      </span>
      <span {...stylex.props(styles.rowItemMeta)}>
        <Trans>Actions: {detail.actions.join(', ')}</Trans>
      </span>
    </li>
  )
}

export function AuthorizationDetailsList({ details }: AuthorizationDetailsListProps): ReactNode {
  const { t } = useLingui()
  if (details.length === 0) return null

  return (
    <section aria-label={t`Requested resource access`} {...stylex.props(styles.permissionSection)}>
      <p {...stylex.props(styles.sectionLabel)}>
        <Trans>Resource access requested</Trans>
      </p>
      <ul {...stylex.props(styles.rowList)}>
        {details.map((detail) => (
          <AuthorizationDetailsItem
            key={`${detail.type}:${detail.locations.join(',')}:${detail.actions.join(',')}`}
            detail={detail}
          />
        ))}
      </ul>
    </section>
  )
}
