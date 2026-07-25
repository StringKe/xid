// EdgeStrip:hero 的边缘节点带(设计稿 .lp-edge)。高亮 EdgeProbe 返回的真实 colo,
// 显示实测边缘 RTT。节点代码是机场字面量不本地化。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { lx } from './landing-theme.stylex'
import { space } from './landing-space.stylex'
import { useEdgeProbeData } from './EdgeProbeProvider'

const SHOWCASE_NODES = ['SJC', 'IAD', 'GRU', 'LHR', 'FRA', 'HKG', 'NRT', 'SYD'] as const

const styles = stylex.create({
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${space.base} ${space.roomy}`,
    paddingBlock: space.snug,
    paddingInline: space.roomy,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: lx.hairline,
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: lx.raised,
  },
  nodes: { display: 'flex', flexWrap: 'wrap', gap: space.tight },
  node: {
    fontFamily: lx.mono,
    fontSize: '0.72rem',
    letterSpacing: '0.04em',
    color: lx.secondary,
    paddingBlock: '0.2rem',
    paddingInline: '0.45rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: lx.hairline,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: lx.page,
    transitionProperty: 'color, border-color, background-color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  nodeOn: {
    color: lx.ink,
    borderColor: lx.ink,
    backgroundColor: `color-mix(in oklch, ${lx.ink} 8%, ${lx.raised})`,
  },
  cap: {
    marginLeft: { default: 'auto', '@media (max-width: 36rem)': 0 },
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    whiteSpace: 'nowrap',
    fontFamily: lx.mono,
    fontSize: '0.72rem',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: lx.secondary,
    opacity: 0.55,
    transitionProperty: 'opacity, color',
    transitionDuration: '0.3s',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  capOn: { opacity: 1, color: lx.primary },
  capDot: {
    width: '0.45rem',
    height: '0.45rem',
    borderRadius: '50%',
    backgroundColor: tokens['--xid-success'],
  },
})

function buildDisplayNodes(colo: string | null): readonly string[] {
  if (!colo) return SHOWCASE_NODES
  if ((SHOWCASE_NODES as readonly string[]).includes(colo)) return SHOWCASE_NODES
  return [...SHOWCASE_NODES, colo]
}

export function EdgeStrip(): ReactNode {
  const { t } = useLingui()
  const probe = useEdgeProbeData()
  const colo = probe?.coloCode ?? null
  const nodes = buildDisplayNodes(colo)
  const settled = colo !== null
  const caption =
    probe && colo
      ? t`Nearest node · ${colo} · ${Math.round(probe.edgeRttMs)}ms from user`
      : t`Nearest edge node`

  return (
    <div {...stylex.props(styles.strip)} aria-label={caption}>
      <div {...stylex.props(styles.nodes)}>
        {nodes.map((node) => (
          <span key={node} {...stylex.props(styles.node, colo === node && styles.nodeOn)}>
            {node}
          </span>
        ))}
      </div>
      <span {...stylex.props(styles.cap, settled && styles.capOn)}>
        <i aria-hidden {...stylex.props(styles.capDot)} />
        {caption}
      </span>
    </div>
  )
}
