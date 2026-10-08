// 上下文栏与窄屏顶栏的组织标识:租户上传 logo 时用 logo,否则用组织名首字母方块;根入口显示 XID。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { BrandLogo } from '@xid-kit/web-ui/BrandLogo'
import { DEFAULT_BRAND, brandLogoUrl, useTheme } from '../../lib/theme'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minWidth: 0,
  },
  tile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2rem',
    height: '2rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-accent'],
    color: tokens['--xid-accent-foreground'],
    fontSize: text.base,
    fontWeight: weight.display,
  },
  tileCompact: {
    width: '1.75rem',
    height: '1.75rem',
    fontSize: text.sm,
  },
  logo: {
    display: 'block',
    height: '2rem',
    maxWidth: '10rem',
    objectFit: 'contain',
  },
  names: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  name: {
    color: tokens['--xid-fg'],
    fontSize: text.md,
    fontWeight: weight.medium,
    lineHeight: '1.25rem',
    overflowWrap: 'anywhere',
  },
  nameCompact: {
    fontSize: text.base,
    lineHeight: '1.125rem',
  },
  host: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1rem',
    overflowWrap: 'anywhere',
  },
})

export type BrandMarkProps = {
  organizationName: string | null
  host?: string
  compact?: boolean
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? ''
}

export function BrandMark({ organizationName, host, compact = false }: BrandMarkProps): ReactNode {
  const { brand, scheme } = useTheme()
  const logoUrl = brandLogoUrl(brand, scheme)
  const hasTenantLogo = Boolean(logoUrl) && logoUrl !== DEFAULT_BRAND.logoUrl
  if (!organizationName) return <BrandLogo height={compact ? 24 : 28} />

  return (
    <div {...stylex.props(styles.root)}>
      {hasTenantLogo ? (
        <img src={logoUrl} alt="" {...stylex.props(styles.logo)} />
      ) : (
        <span aria-hidden="true" {...stylex.props(styles.tile, compact && styles.tileCompact)}>
          {initialOf(organizationName)}
        </span>
      )}
      <div {...stylex.props(styles.names)}>
        <span {...stylex.props(styles.name, compact && styles.nameCompact)}>
          {organizationName}
        </span>
        {host && !compact ? <span {...stylex.props(styles.host)}>{host}</span> : null}
      </div>
    </div>
  )
}
