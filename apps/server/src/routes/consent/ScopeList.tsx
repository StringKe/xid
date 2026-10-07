// 权限清单:每项写成「能做什么 + 具体数据」;再次授权只列新增项,已同意的合成一行。RAR 资源单独成框。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Icon } from '../../components/ui'
import { SCOPE_COPY, useScopeLabel } from '../../components/hosted/scope-copy'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'
import type { AuthorizationDetail } from './consent-model'

const styles = stylex.create({
  heading: {
    margin: 0,
    paddingBottom: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  icon: {
    flexShrink: 0,
    marginTop: '0.0625rem',
    color: tokens['--xid-muted-foreground'],
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  label: {
    fontSize: text.base,
    lineHeight: '1.125rem',
    color: tokens['--xid-fg'],
  },
  detail: {
    fontSize: text.sm,
    lineHeight: '1.125rem',
    color: tokens['--xid-muted-foreground'],
    overflowWrap: 'anywhere',
  },
  allowed: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
  },
  resources: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    overflow: 'hidden',
  },
  resourceHead: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.875rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    overflowWrap: 'anywhere',
  },
  action: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.875rem',
    borderTopWidth: { default: '1px', ':first-child': 0 },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    fontSize: text.base,
  },
})

export function ScopeList(props: {
  heading: ReactNode
  scopes: readonly string[]
  details: Readonly<Record<string, ReactNode>>
}): ReactNode {
  const label = useScopeLabel()
  if (props.scopes.length === 0) return null
  return (
    <section>
      <h2 {...stylex.props(styles.heading)}>{props.heading}</h2>
      <ul {...stylex.props(styles.list)}>
        {props.scopes.map((scope) => (
          <li key={scope} {...stylex.props(styles.item)}>
            <span aria-hidden="true" {...stylex.props(styles.icon)}>
              <Icon name={SCOPE_COPY[scope]?.icon ?? 'key'} size={16} />
            </span>
            <span {...stylex.props(styles.body)}>
              <span {...stylex.props(styles.label)}>{label(scope)}</span>
              {props.details[scope] ? (
                <span {...stylex.props(styles.detail)}>{props.details[scope]}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AlreadyAllowed({ scopes }: { scopes: readonly string[] }): ReactNode {
  const label = useScopeLabel()
  if (scopes.length === 0) return null
  return (
    <div {...stylex.props(styles.allowed)}>
      <span {...stylex.props(styles.label)}>
        <Trans>Already allowed</Trans>
      </span>
      <span {...stylex.props(styles.detail)}>{scopes.map(label).join(', ')}</span>
    </div>
  )
}

export function AuthorizationDetailsList({
  details,
}: {
  details: readonly AuthorizationDetail[]
}): ReactNode {
  if (details.length === 0) return null
  return (
    <>
      {details.map((detail) => (
        <section
          key={`${detail.type}:${detail.locations.join(',')}`}
          {...stylex.props(styles.resources)}
        >
          <div {...stylex.props(styles.resourceHead)}>
            <span {...stylex.props(styles.label)}>
              <Trans>Protected resource</Trans>
            </span>
            {detail.locations.map((location) => (
              <span key={location} {...stylex.props(styles.mono)}>
                {location}
              </span>
            ))}
          </div>
          <ul {...stylex.props(styles.list)}>
            {detail.actions.map((action) => (
              <li key={action} {...stylex.props(styles.action)}>
                {action}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}
