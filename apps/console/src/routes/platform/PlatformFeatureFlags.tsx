// platform console Feature Flags 页:全局 flag 列表 + 全局默认开关。
// 调 GET /v1/platform/feature-flags;PATCH /v1/platform/feature-flags/:key。
// 全宽锚定版式:零 padding 壳,节自持 gutter;hairline ledger(borderBlock 1px)包裹行列表;
// 行间 hairline 分隔;flags 行 4/8 不对称双列(左 flag 信息,右控件),宽屏更清晰。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, EmptyState, Spinner } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useFeatureFlagsQuery, useSetFeatureFlagDefault } from './queries'
import type { FeatureFlag } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  section: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  sectionLabelRow: {
    marginBottom: '1rem',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBlock: '3rem',
    paddingInline: GUTTER,
  },
  // ledger 带:borderBlock 1px 包裹 flag 行列表
  flagList: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  flagRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': 'minmax(0, 4fr) minmax(0, 8fr)',
    },
    alignItems: 'center',
    gap: '1rem',
    // hairline 邻接 >= 1.25rem:行文本与上方 borderTop hairline 各需 1.25rem
    paddingBlock: '1.25rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  flagRowFirst: {
    borderTopWidth: 0,
  },
  flagBody: {
    minWidth: 0,
  },
  flagMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.25rem',
    flexWrap: 'wrap',
  },
  flagKey: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.125rem',
    paddingInline: '0.375rem',
    borderRadius: tokens['--xid-radius-sm'],
    color: tokens['--xid-fg'],
  },
  flagLabel: {
    fontWeight: 600,
    fontSize: '0.875rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  flagDesc: {
    margin: 0,
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
  flagOverrides: {
    margin: '0.25rem 0 0',
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.04em',
  },
  flagControls: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    paddingTop: {
      default: '0.5rem',
      '@media (min-width: 48rem)': '0',
    },
  },
  toggleBtn: {
    minHeight: '2rem',
    paddingBlock: 0,
    paddingInline: '0.75rem',
    fontSize: '0.8125rem',
  },
})

function FlagRow({
  flag,
  isFirst,
  onToggle,
  toggling,
}: {
  flag: FeatureFlag
  isFirst: boolean
  onToggle: (key: string, enabled: boolean) => void
  toggling: boolean
}): ReactNode {
  const { t } = useLingui()

  return (
    <div {...stylex.props(styles.flagRow, isFirst && styles.flagRowFirst)}>
      <div {...stylex.props(styles.flagBody)}>
        <div {...stylex.props(styles.flagMeta)}>
          <code {...stylex.props(styles.flagKey)}>{flag.key}</code>
          <span {...stylex.props(styles.flagLabel)}>{flag.label}</span>
        </div>
        {flag.description ? <p {...stylex.props(styles.flagDesc)}>{flag.description}</p> : null}
        {flag.organizationOverrides > 0 ? (
          <p {...stylex.props(styles.flagOverrides)}>
            <Trans>{flag.organizationOverrides} organization overrides</Trans>
          </p>
        ) : null}
      </div>
      <div {...stylex.props(styles.flagControls)}>
        <Badge tone={flag.globalDefault ? 'success' : 'neutral'}>
          {flag.globalDefault ? <Trans>ON</Trans> : <Trans>OFF</Trans>}
        </Badge>
        <Button
          variant={flag.globalDefault ? 'secondary' : 'primary'}
          isLoading={toggling}
          onClick={() => onToggle(flag.key, !flag.globalDefault)}
          aria-label={t`Toggle ${flag.key} flag`}
          {...stylex.props(styles.toggleBtn)}
        >
          {flag.globalDefault ? <Trans>Disable</Trans> : <Trans>Enable</Trans>}
        </Button>
      </div>
    </div>
  )
}

export default function PlatformFeatureFlags(): ReactNode {
  const { data, isLoading, isError } = useFeatureFlagsQuery()
  const setFlagDefault = useSetFeatureFlagDefault()

  function handleToggle(key: string, enabled: boolean): void {
    void setFlagDefault.mutate({ key, globalDefault: enabled })
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Feature flags</Trans>
        </h1>
      </div>

      {setFlagDefault.error ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{setFlagDefault.error.message}</Alert>
        </div>
      ) : null}

      {isLoading ? (
        <div {...stylex.props(styles.loadingZone)}>
          <Spinner />
        </div>
      ) : isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load feature flags. Please try again.</Trans>
          </Alert>
        </div>
      ) : !data || data.length === 0 ? (
        <div {...stylex.props(styles.messageZone)}>
          <EmptyState title={<Trans>No feature flags configured.</Trans>} />
        </div>
      ) : (
        <section aria-labelledby="flags-heading" {...stylex.props(styles.section)}>
          <h2 id="flags-heading" {...stylex.props(page.sectionLabel, styles.sectionLabelRow)}>
            <Trans>Global defaults</Trans>
          </h2>
          <div {...stylex.props(styles.flagList)}>
            {data.map((flag, idx) => (
              <FlagRow
                key={flag.key}
                flag={flag}
                isFirst={idx === 0}
                onToggle={handleToggle}
                toggling={setFlagDefault.isPending && setFlagDefault.variables?.key === flag.key}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
