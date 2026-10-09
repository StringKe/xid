// 组织邮箱域名与路由状态(只读):已验证的域名即路由到本组织唯一的企业连接。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Badge, Button } from '@xid-kit/web-ui/ui'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { formatDate } from '../../lib/date-format'
import type { RoutedDomain } from './auth-queries'
import { detailParts } from './AuthDetailParts'

const WIDE = '@media (min-width: 48rem)'
export const DOMAINS_PATH = '/console/org/domains'

const styles = stylex.create({
  head: {
    display: { default: 'none', [WIDE]: 'grid' },
    gridTemplateColumns: 'minmax(0, 1fr) 13.5rem 14rem',
    gap: '1rem',
    paddingBlock: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr) auto', [WIDE]: 'minmax(0, 1fr) 13.5rem 14rem' },
    alignItems: 'center',
    gap: '0.25rem 1rem',
    minHeight: '3.25rem',
    paddingBlock: '0.5rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  domain: {
    color: tokens['--xid-fg'],
    fontSize: { default: text.md, [WIDE]: text.base },
    fontWeight: { default: weight.regular, [WIDE]: weight.medium },
    overflowWrap: 'anywhere',
  },
  wide: {
    display: { default: 'none', [WIDE]: 'flex' },
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  narrow: {
    display: { default: 'block', [WIDE]: 'none' },
    gridColumn: '1 / 2',
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  routed: {
    color: tokens['--xid-success'],
  },
  pending: {
    color: tokens['--xid-muted-foreground'],
  },
  routingText: {
    color: tokens['--xid-fg'],
    fontSize: text.base,
  },
  routingMuted: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  empty: {
    margin: 0,
    paddingBlock: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
})

function DomainRow({ domain }: { domain: RoutedDomain }): ReactNode {
  const { i18n } = useLingui()
  const navigate = useNavigate()
  const verifiedOn = formatDate(i18n, domain.verifiedAt)
  const count = domain.memberCount
  return (
    <li {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.domain)}>{domain.domain}</span>
      <span {...stylex.props(styles.wide)}>
        {domain.verified ? (
          <Badge tone="success">
            {verifiedOn ? <Trans>Verified {verifiedOn}</Trans> : <Trans>Verified</Trans>}
          </Badge>
        ) : (
          <Badge tone="neutral">
            <Trans>Waiting for DNS record</Trans>
          </Badge>
        )}
      </span>
      <span {...stylex.props(styles.wide)}>
        {domain.verified ? (
          <span {...stylex.props(styles.routingText)}>
            <Plural value={count} one="Routed, # person" other="Routed, # people" />
          </span>
        ) : (
          <>
            <span {...stylex.props(styles.routingMuted)}>
              <Trans>Not routed yet</Trans>
            </span>
            <Button type="button" variant="secondary" onClick={() => navigate(DOMAINS_PATH)}>
              <Trans>DNS record…</Trans>
            </Button>
          </>
        )}
      </span>
      <span {...stylex.props(styles.narrow, domain.verified ? styles.routed : styles.pending)}>
        {domain.verified ? (
          <Plural
            value={count}
            one="Verified, routed for # person"
            other="Verified, routed for # people"
          />
        ) : (
          <Trans>Waiting for DNS record</Trans>
        )}
      </span>
    </li>
  )
}

export function SsoDomainList({ domains }: { domains: readonly RoutedDomain[] }): ReactNode {
  if (domains.length === 0) {
    return (
      <p {...stylex.props(styles.empty)}>
        <Trans>No email domains yet. Add and verify a domain to route it here.</Trans>
      </p>
    )
  }
  return (
    <div>
      <div aria-hidden {...stylex.props(styles.head)}>
        <span>
          <Trans>Domain</Trans>
        </span>
        <span>
          <Trans>Ownership</Trans>
        </span>
        <span>
          <Trans>Routing</Trans>
        </span>
      </div>
      <ul {...stylex.props(detailParts.rows)}>
        {domains.map((domain) => (
          <DomainRow key={domain.domain} domain={domain} />
        ))}
      </ul>
    </div>
  )
}
