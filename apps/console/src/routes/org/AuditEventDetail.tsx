// 审计日志一行展开后的内容:actor / target、链上位置与事件 JSON。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { CopyButton } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { orgPath } from './AttentionList'
import { useAuditNames } from './AuditSentenceParts'
import type { AuditEntry } from './overview-queries'

const styles = stylex.create({
  detail: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 64rem)': 'row' },
    gap: { default: '1.25rem', '@media (min-width: 64rem)': '2rem' },
    position: 'sticky',
    insetInlineStart: 0,
    maxWidth: { default: 'calc(100vw - 2rem)', '@media (min-width: 64rem)': 'none' },
  },
  facts: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    flexShrink: 0,
    width: { default: 'auto', '@media (min-width: 64rem)': '18.75rem' },
    margin: 0,
  },
  fact: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  },
  factLabel: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
  factValue: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  mono: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: leading.xs,
    overflowWrap: 'anywhere',
  },
  link: {
    color: tokens['--xid-accent'],
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  json: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    flex: '1 1 auto',
    minWidth: 0,
  },
  jsonHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  jsonTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  pre: {
    margin: 0,
    paddingBlock: '0.875rem',
    paddingInline: '1rem',
    overflowX: 'auto',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: '1.1875rem',
  },
})

function eventJson(entry: AuditEntry): string {
  return JSON.stringify(
    {
      action: entry.eventType,
      ts: entry.occurredAt,
      actor: { id: entry.actorId, type: entry.actor.kind },
      target: { id: entry.targetId, type: entry.targetType },
      payload: entry.payload,
      ip: entry.actorIp,
      seq: entry.seq,
      prev_hash: entry.prevHash,
    },
    null,
    2,
  )
}

export function AuditDetail({ entry, orgId }: { entry: AuditEntry; orgId: string }): ReactNode {
  const { i18n } = useLingui()
  const { actor, target } = useAuditNames(entry)
  const seq = i18n.number(entry.seq)
  const targetIsUser = entry.targetType === 'user' && entry.targetId
  return (
    <div {...stylex.props(styles.detail)}>
      <dl {...stylex.props(styles.facts)}>
        <div {...stylex.props(styles.fact)}>
          <dt {...stylex.props(styles.factLabel)}>
            <Trans>Actor</Trans>
          </dt>
          <dd {...stylex.props(styles.factValue)}>{actor}</dd>
          {entry.actorId && entry.actorId !== 'system' ? (
            <dd {...stylex.props(styles.mono)}>{entry.actorId}</dd>
          ) : null}
        </div>
        {entry.targetId ? (
          <div {...stylex.props(styles.fact)}>
            <dt {...stylex.props(styles.factLabel)}>
              <Trans>Target</Trans>
            </dt>
            <dd {...stylex.props(styles.factValue)}>
              {targetIsUser ? (
                <Link
                  to={orgPath(
                    `/console/org/users/${encodeURIComponent(entry.targetId ?? '')}`,
                    orgId,
                  )}
                  {...stylex.props(styles.link)}
                >
                  {target}
                </Link>
              ) : (
                target
              )}
            </dd>
            <dd {...stylex.props(styles.mono)}>{entry.targetId}</dd>
          </div>
        ) : null}
        <div {...stylex.props(styles.fact)}>
          <dt {...stylex.props(styles.factLabel)}>
            <Trans>Entry</Trans>
          </dt>
          <dd {...stylex.props(styles.factValue)}>
            <Trans>No. {seq} in the chain</Trans>
          </dd>
        </div>
      </dl>
      <div {...stylex.props(styles.json)}>
        <div {...stylex.props(styles.jsonHead)}>
          <p {...stylex.props(styles.jsonTitle)}>
            <Trans>Event JSON</Trans>
          </p>
          <CopyButton value={eventJson(entry)} subject="JSON" />
        </div>
        <pre {...stylex.props(styles.pre)}>{eventJson(entry)}</pre>
      </div>
    </div>
  )
}
