// FederationSection:按证据等级标注的企业联合矩阵(设计稿 .lp-matrix)。
// 全宽贴边分节:SectionHead(4/8 登记行)在 measure 容器内;
// matrix 表全宽 ledger — 竖向 hairline 划三列,首尾经 edgeStart/edgeEnd 持页边距;
// targets strip 横贯底部 hairline 行。
// 每行 = 能力 + 支持等级徽标(implemented/provider-ready/planned)+ mono 证据注;
// 没有证据的能力不做声明,这是产品姿态也是页面文案。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Badge } from '../../components/ui'
import type { BadgeTone } from '../../components/ui'
import { lx } from './landing-theme.stylex'
import { shared } from './landing-styles'
import { Section, SectionHead } from './SectionShell'

const FEDERATION_TARGETS = [
  'Okta',
  'Microsoft Entra',
  'Google Workspace',
  'Slack',
  'GitHub Enterprise',
  'Atlassian',
  'Salesforce',
  'Zoom',
] as const

const TIER_TONE: Record<string, BadgeTone> = {
  implemented: 'success',
  ready: 'info',
  planned: 'neutral',
}

const CELL_PAD = 'clamp(1.25rem, 2.5vw, 3.5rem)'
// 与 landing-styles 的 gutter 口径一致(StyleX 静态值,内联副本)。
const GUTTER = 'clamp(1.25rem, 3vw, 4.5rem)'

// 徽标列固定宽:最长标签 Provider-ready 对齐,禁止 auto 列宽逐行漂移。
const BADGE_COL = '10.5rem'

const styles = stylex.create({
  // matrix 包裹:全宽贴边 ledger,上 hairline 分节;单列 grid 保证各行竖线对齐。
  matrixWrap: {
    display: 'grid',
    gridTemplateColumns: {
      default: `minmax(0, 5fr) ${BADGE_COL} minmax(0, 4fr)`,
      '@media (max-width: 48rem)': `minmax(0, 1fr) ${BADGE_COL}`,
    },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: lx.hairline,
  },
  // display:contents 让三格 cell 参与父 grid,竖向 hairline 跨行对齐。
  matrixRow: {
    display: 'contents',
  },
  // 首列:edgeStart 持页边距 + 列内 gutter(内容不贴竖向 hairline)。
  // 行高走 hairline 邻接口径:文本与行分隔线距离 >= 1.25rem。
  matrixCellFirst: {
    paddingBlock: '1.25rem',
    paddingInlineEnd: CELL_PAD,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: lx.hairline,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.hairline,
    backgroundColor: { default: 'transparent', ':hover': lx.sunken },
    transitionProperty: 'background-color',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  // 中列(徽标):固定宽列内居中;<=48rem 成为右缘列,右内距改页边距口径。
  matrixCellBadge: {
    paddingBlock: '1.25rem',
    paddingInlineStart: CELL_PAD,
    paddingInlineEnd: { default: CELL_PAD, '@media (max-width: 48rem)': GUTTER },
    borderRightWidth: '1px',
    borderRightStyle: { default: 'solid', '@media (max-width: 48rem)': 'none' },
    borderRightColor: lx.hairline,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.hairline,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: { default: 'transparent', ':hover': lx.sunken },
    transitionProperty: 'background-color',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  // 末列(证据注):edgeEnd 持页边距 + 列内 gutter
  matrixCellLast: {
    paddingBlock: '1.25rem',
    paddingInlineStart: CELL_PAD,
    display: { default: 'flex', '@media (max-width: 48rem)': 'none' },
    alignItems: 'center',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: lx.hairline,
    backgroundColor: { default: 'transparent', ':hover': lx.sunken },
    transitionProperty: 'background-color',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  cap: { fontSize: '0.9375rem', fontWeight: 560, color: lx.primary },
  // 列头行:与数据行同列格线,microlabel 标列义;浅底把表头从数据行里降下去。
  // nowrap:徽标列固定宽 + 双侧 gutter 时,"Support level" 这类两词标签不许折行。
  matrixHeadCell: {
    paddingBlock: '0.875rem',
    backgroundColor: lx.sunken,
    whiteSpace: 'nowrap',
  },
  evidence: {
    fontFamily: lx.mono,
    fontSize: '0.75rem',
    color: lx.secondary,
  },
  // targets 横贯 ledger 行:上边界由末行 borderBottom 提供(不再自带,避免双 hairline)。
  // 底空间由调用处混 shared.sectionFoot(节内最后文本行距节底线口径)。
  targetsRow: {
    paddingTop: 'clamp(1.5rem, 2.5vw, 2.5rem)',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem 2rem',
  },
  // 纯证言文本不可交互,不给 hover 伪反馈。
  stripItem: {
    fontSize: '1rem',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    color: lx.secondary,
  },
})

type MatrixRow = {
  id: string
  capability: string
  tier: string
  tierLabel: string
  evidence: string
}

function useMatrixRows(): readonly MatrixRow[] {
  const { t } = useLingui()
  const tiers = { implemented: t`Implemented`, ready: t`Provider-ready`, planned: t`Planned` }
  return [
    {
      id: 'saml-sp',
      capability: t`Inbound SAML SP`,
      tier: 'implemented',
      tierLabel: tiers.implemented,
      evidence: t`SP-initiated · IdP metadata import`,
    },
    {
      id: 'oidc-rp',
      capability: t`Upstream OIDC RP`,
      tier: 'implemented',
      tierLabel: tiers.implemented,
      evidence: t`Authorization code · PKCE S256`,
    },
    {
      id: 'scim-in',
      capability: t`Inbound SCIM 2.0`,
      tier: 'implemented',
      tierLabel: tiers.implemented,
      evidence: t`Users + groups provisioning`,
    },
    {
      id: 'device-flow',
      capability: t`Device flow`,
      tier: 'implemented',
      tierLabel: tiers.implemented,
      evidence: 'RFC 8628',
    },
    {
      id: 'saas-sso',
      capability: t`Downstream SaaS SSO`,
      tier: 'ready',
      tierLabel: tiers.ready,
      evidence: t`Local baseline verified · real SaaS run not claimed`,
    },
    {
      id: 'scim-out',
      capability: t`Outbound SCIM`,
      tier: 'planned',
      tierLabel: tiers.planned,
      evidence: t`Scoped, not claimed`,
    },
  ]
}

export function FederationSection(): ReactNode {
  const rows = useMatrixRows()
  return (
    <Section id="federation" bleed>
      {/* SectionHead 在 measure 容器内保持 4/8 登记行节奏;bleedHead 持节顶口径 */}
      <div {...stylex.props(shared.measure, shared.bleedHead)}>
        <SectionHead
          kicker={<Trans>Federation</Trans>}
          heading={<Trans>Enterprise federation, labeled by evidence.</Trans>}
          sub={
            <Trans>
              This matrix is the contract: what is implemented, what is provider-ready, and what is
              not claimed yet.
            </Trans>
          }
        />
      </div>
      {/* matrix 全宽 ledger:父级单列 grid + display:contents 行,保证徽标列跨行对齐 */}
      <div {...stylex.props(styles.matrixWrap)}>
        {/* 列头行:同列格线上的 microlabel 表头,把矩阵读成账本 */}
        <div {...stylex.props(styles.matrixRow)}>
          <span
            {...stylex.props(
              shared.edgeStart,
              styles.matrixCellFirst,
              styles.matrixHeadCell,
              shared.microlabel,
            )}
          >
            <Trans>Capability</Trans>
          </span>
          <span {...stylex.props(styles.matrixCellBadge, styles.matrixHeadCell, shared.microlabel)}>
            <Trans>Support level</Trans>
          </span>
          <span
            {...stylex.props(
              shared.edgeEnd,
              styles.matrixCellLast,
              styles.matrixHeadCell,
              shared.microlabel,
            )}
          >
            <Trans>Evidence</Trans>
          </span>
        </div>
        {rows.map((row) => (
          <div key={row.id} {...stylex.props(styles.matrixRow)}>
            <span {...stylex.props(shared.edgeStart, styles.matrixCellFirst, styles.cap)}>
              {row.capability}
            </span>
            <span {...stylex.props(styles.matrixCellBadge)}>
              <Badge tone={TIER_TONE[row.tier] ?? 'neutral'}>{row.tierLabel}</Badge>
            </span>
            <span {...stylex.props(shared.edgeEnd, styles.matrixCellLast, styles.evidence)}>
              {row.evidence}
            </span>
          </div>
        ))}
      </div>
      {/* targets 横贯 ledger 行:edgeStart/edgeEnd 持页边距,sectionFoot 持节底口径 */}
      <div
        {...stylex.props(shared.edgeStart, shared.edgeEnd, styles.targetsRow, shared.sectionFoot)}
      >
        <span {...stylex.props(shared.microlabel)}>
          <Trans>Federation targets</Trans>
        </span>
        {FEDERATION_TARGETS.map((target) => (
          <span key={target} {...stylex.props(styles.stripItem)}>
            {target}
          </span>
        ))}
      </div>
    </Section>
  )
}
