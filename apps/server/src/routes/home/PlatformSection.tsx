// PlatformSection:平台能力全宽 ledger 网格。顶部主行 7/5 不对称 hairline 划栏:
// 左侧 OIDC/OAuth 协议面(最重内容),右侧边缘验证(flow 示意)。
// 下方三格 4/4/4 横贯全宽,竖向 hairline 划列,首尾列持页边距。
// 悬停仅改描边颜色,不堆阴影。tile 内部 badge/checks/flow 行为原样保留。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Badge } from '../../components/ui'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { space } from './landing-space.stylex'
import { Icon } from './landing-icons'
import { Reveal } from './Reveal'
import { Section, SectionHead } from './SectionShell'
import { useEdgeProbeData } from './EdgeProbeProvider'
import { formatRoundTrips, formatTokenWindow } from './edge-probe-format'

const CELL_PAD = 'clamp(1.5rem, 2.5vw, 3rem)'
// 与 landing-styles 的 gutter 口径一致(StyleX 静态值,内联副本)。
const GUTTER = 'clamp(1.25rem, 3vw, 4.5rem)'

const styles = stylex.create({
  // 主行:7/5 hairline 划栏,贴边全宽
  primaryRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 7fr) minmax(0, 5fr)',
      '@media (max-width: 60rem)': 'minmax(0, 1fr)',
    },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  primaryCell: {
    paddingBlock: CELL_PAD,
    // 列内 gutter:内容不贴中央竖向 hairline;堆叠后右缘改持页边距。
    paddingInlineEnd: { default: CELL_PAD, '@media (max-width: 60rem)': GUTTER },
    borderRightWidth: '1px',
    borderRightStyle: { default: 'solid', '@media (max-width: 60rem)': 'none' },
    borderRightColor: lx.hairline,
    borderBottomWidth: '1px',
    borderBottomStyle: { default: 'none', '@media (max-width: 60rem)': 'solid' },
    borderBottomColor: lx.hairline,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
  },
  primaryCellRight: {
    borderRightWidth: 0,
    backgroundColor: lx.sunken,
    paddingBlock: CELL_PAD,
    paddingInlineStart: { default: CELL_PAD, '@media (max-width: 60rem)': GUTTER },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
    borderBottomWidth: 0,
  },
  // 下方三格 ledger 行
  secondaryRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(3, minmax(0, 1fr))',
      '@media (max-width: 48rem)': 'repeat(2, minmax(0, 1fr))',
      '@media (max-width: 32rem)': 'minmax(0, 1fr)',
    },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  secondaryCell: {
    paddingBlock: CELL_PAD,
    // 列内 gutter 双侧自持;单列堆叠(<=32rem)时两侧改持页边距。
    paddingInlineStart: { default: CELL_PAD, '@media (max-width: 32rem)': GUTTER },
    paddingInlineEnd: { default: CELL_PAD, '@media (max-width: 32rem)': GUTTER },
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: lx.hairline,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    // 窄屏折叠时中间格去右线,第三格换行补上边线
    borderBottomWidth: 0,
  },
  secondaryCellLast: {
    borderRightWidth: 0,
  },
  // <=48rem 双列:中间格成为首行右缘格,右内距改页边距口径。
  secondaryCellMid: {
    paddingInlineEnd: { default: CELL_PAD, '@media (max-width: 48rem)': GUTTER },
  },
  // 窄屏:第三格去左线+补上边线,换行后左缘持页边距
  secondaryCellThird: {
    paddingInlineStart: { default: CELL_PAD, '@media (max-width: 48rem)': GUTTER },
    borderTopWidth: {
      default: '0',
      '@media (max-width: 48rem)': '1px',
    },
    borderTopStyle: {
      default: 'none',
      '@media (max-width: 48rem)': 'solid',
    },
    borderTopColor: lx.hairline,
    borderRightStyle: {
      default: 'solid',
      '@media (max-width: 48rem)': 'none',
    },
  },
  tileKicker: {
    color: lx.ink,
  },
  tileTitle: {
    fontSize: 'clamp(1rem, 0.9rem + 0.3vw, 1.25rem)',
    fontWeight: 630,
    letterSpacing: '-0.018em',
    lineHeight: 1.2,
    margin: 0,
    textWrap: 'balance',
    color: lx.primary,
  },
  tileBody: {
    fontSize: '0.9rem',
    lineHeight: 1.6,
    color: lx.secondary,
    margin: 0,
  },
  tileSpec: {
    marginTop: 'auto',
    fontFamily: lx.mono,
    fontSize: '0.75rem',
    color: lx.secondary,
    letterSpacing: '0.02em',
    // hairline 邻接口径:文本与 1px 线距离 >= 1.25rem。
    paddingTop: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'dashed',
    borderTopColor: lx.hairline,
  },
  badges: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem' },
  flow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.base,
    flexWrap: 'wrap',
    fontFamily: lx.mono,
    fontSize: '0.72rem',
    color: lx.secondary,
  },
  flowNode: {
    paddingBlock: '0.3rem',
    paddingInline: '0.55rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: lx.strong,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: lx.page,
    color: lx.primary,
  },
  flowNodeBrand: {
    borderColor: lx.ink,
    color: lx.ink,
    backgroundColor: `color-mix(in oklch, ${lx.ink} 8%, ${lx.raised})`,
  },
  flowArrow: { color: lx.ink },
  query: {
    fontFamily: lx.mono,
    fontSize: '0.75rem',
    color: lx.primary,
    backgroundColor: lx.sunken,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: lx.hairline,
    borderRadius: tokens['--xid-radius-sm'],
    paddingBlock: '0.375rem',
    paddingInline: '0.55rem',
    alignSelf: 'flex-start',
  },
  checks: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3rem',
  },
  check: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.45rem',
    fontFamily: lx.mono,
    fontSize: '0.75rem',
    color: lx.primary,
  },
  checkIcon: { color: tokens['--xid-success'], flexShrink: 0, display: 'inline-flex' },
})

function PasskeyChecks(): ReactNode {
  const { t } = useLingui()
  const checks = [t`Challenge`, t`Origin`, t`RP ID hash`, t`Signature`]
  return (
    <ul {...stylex.props(styles.checks)}>
      {checks.map((check) => (
        <li key={check} {...stylex.props(styles.check)}>
          <span {...stylex.props(styles.checkIcon)}>
            <Icon name="check" size={13} strokeWidth={2.4} />
          </span>
          {check}
        </li>
      ))}
    </ul>
  )
}

type FlowProps = { nodes: ReadonlyArray<{ id: string; label: ReactNode; brand?: boolean }> }

function Flow({ nodes }: FlowProps): ReactNode {
  return (
    <div {...stylex.props(styles.flow)}>
      {nodes.flatMap((node, index) => [
        index > 0 ? (
          <span key={`${node.id}-arrow`} aria-hidden {...stylex.props(styles.flowArrow)}>
            {'->'}
          </span>
        ) : null,
        <span key={node.id} {...stylex.props(styles.flowNode, node.brand && styles.flowNodeBrand)}>
          {node.label}
        </span>,
      ])}
    </div>
  )
}

export function PlatformSection(): ReactNode {
  const { t } = useLingui()
  const probe = useEdgeProbeData()
  const edgeSpec =
    probe !== null
      ? t`${probe.signingAlg} · ${formatRoundTrips(probe.jwksRoundTrips)} round trips · ${formatTokenWindow(probe.accessTokenTtlSec)} token window`
      : t`Measuring edge verify…`

  return (
    <Section id="platform" bleed>
      {/* bleed 节自管节奏:head 区持节顶口径(shared.bleedHead) */}
      <div {...stylex.props(shared.measure, shared.bleedHead)}>
        <SectionHead
          kicker={<Trans>Platform</Trans>}
          heading={<Trans>Every surface, one Worker.</Trans>}
          sub={
            <Trans>
              No inflated claims. We publish an explicit support level for every surface, with the
              evidence behind it.
            </Trans>
          }
        />
      </div>
      {/* 主行:7/5 hairline ledger */}
      <Reveal sx={styles.primaryRow}>
        <div {...stylex.props(shared.edgeStart, styles.primaryCell)}>
          <span {...stylex.props(shared.microlabel, styles.tileKicker)}>
            <Trans>Protocol surface</Trans>
          </span>
          <h3 {...stylex.props(styles.tileTitle)}>
            <Trans>OIDC & OAuth, implemented to spec</Trans>
          </h3>
          <p {...stylex.props(styles.tileBody)}>
            <Trans>
              Authorization code with mandatory PKCE S256, refresh-token rotation with reuse-family
              revocation, DPoP, PAR, and device flow.
            </Trans>
          </p>
          <div {...stylex.props(styles.badges)}>
            <Badge tone="success">PKCE S256</Badge>
            <Badge tone="success">
              <Trans>Refresh rotation</Trans>
            </Badge>
            <Badge tone="info">DPoP</Badge>
            <Badge tone="info">PAR</Badge>
            <Badge tone="neutral">RFC 8628</Badge>
          </div>
          <div {...stylex.props(styles.tileSpec)}>
            <Trans>Optional extensions labeled, never assumed</Trans>
          </div>
        </div>
        <div {...stylex.props(shared.edgeEnd, styles.primaryCellRight)}>
          <span {...stylex.props(shared.microlabel, styles.tileKicker)}>
            <Trans>Edge verify</Trans>
          </span>
          <h3 {...stylex.props(styles.tileTitle)}>
            <Trans>Networkless verification</Trans>
          </h3>
          <p {...stylex.props(styles.tileBody)}>
            <Trans>
              The SDK validates short-lived JWTs against cached JWKS with no call back to the API. A
              cold Worker authorizes in microseconds.
            </Trans>
          </p>
          <Flow
            nodes={[
              { id: 'jwks', label: <Trans>Cached JWKS</Trans> },
              { id: 'verify', label: <Trans>verify</Trans>, brand: true },
              { id: 'claims', label: 'claims' },
            ]}
          />
          <div {...stylex.props(styles.tileSpec)}>{edgeSpec}</div>
        </div>
      </Reveal>
      {/* 下方三格 4/4/4:节内最后贴边行,文本经 sectionFoot 离节底线 */}
      <Reveal sx={styles.secondaryRow}>
        <div {...stylex.props(styles.secondaryCell, shared.edgeStart, shared.sectionFoot)}>
          <span {...stylex.props(shared.microlabel, styles.tileKicker)}>
            <Trans>Org RBAC</Trans>
          </span>
          <h3 {...stylex.props(styles.tileTitle)}>
            <Trans>Organization RBAC</Trans>
          </h3>
          <p {...stylex.props(styles.tileBody)}>
            <Trans>
              One codebase, single- or multi-org by config. Every query carries an enforced org
              filter.
            </Trans>
          </p>
          <code {...stylex.props(styles.query)}>WHERE org_id = ctx.org</code>
          <div {...stylex.props(styles.tileSpec)}>
            <Trans>Instance issuer · row-level isolation</Trans>
          </div>
        </div>
        <div {...stylex.props(styles.secondaryCell, styles.secondaryCellMid, shared.sectionFoot)}>
          <span {...stylex.props(shared.microlabel, styles.tileKicker)}>WebAuthn</span>
          <h3 {...stylex.props(styles.tileTitle)}>
            <Trans>Passkeys, four-way verified</Trans>
          </h3>
          <p {...stylex.props(styles.tileBody)}>
            <Trans>Four checks on every assertion. No skip path.</Trans>
          </p>
          <PasskeyChecks />
          <div {...stylex.props(styles.tileSpec)}>
            <Trans>UV required · clone detection</Trans>
          </div>
        </div>
        <div
          {...stylex.props(
            styles.secondaryCell,
            styles.secondaryCellLast,
            styles.secondaryCellThird,
            shared.edgeEnd,
            shared.sectionFoot,
          )}
        >
          <span {...stylex.props(shared.microlabel, styles.tileKicker)}>
            <Trans>Federation</Trans>
          </span>
          <h3 {...stylex.props(styles.tileTitle)}>
            <Trans>Inbound enterprise federation</Trans>
          </h3>
          <p {...stylex.props(styles.tileBody)}>
            <Trans>
              XID is the SAML SP or OIDC RP for upstream IdPs; SCIM 2.0 provisions users and groups
              in.
            </Trans>
          </p>
          <Flow
            nodes={[
              { id: 'okta', label: 'Okta' },
              { id: 'fed', label: 'SAML / OIDC' },
              { id: 'xid', label: 'XID', brand: true },
            ]}
          />
          <div {...stylex.props(styles.tileSpec)}>
            <Trans>Inbound SAML · upstream OIDC · inbound SCIM</Trans>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}
