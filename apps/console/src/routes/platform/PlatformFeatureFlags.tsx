
import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, EmptyState, Spinner } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useFeatureFlagsQuery, useSetFeatureFlagDefault } from './queries'
import type { FeatureFlag } from './types'

const styles = stylex.create({
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
    // 1.25rem:行文与上下 hairline 邻接下限。
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
  const { t } = useLingui()
  const { data, isLoading, isError } = useFeatureFlagsQuery()
  const setFlagDefault = useSetFeatureFlagDefault()

  function handleToggle(key: string, enabled: boolean): void {
    void setFlagDefault.mutate({ key, globalDefault: enabled })
  }

  return (
    <ConsolePage
      title={<Trans>Feature flags</Trans>}
      lead={<Trans>Global defaults for every feature flag, with organization overrides.</Trans>}
    >
      {isError || setFlagDefault.isError ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load feature flags. Please try again.</Trans>
            </Alert>
          ) : null}
          {setFlagDefault.isError ? (
            <Alert tone="error">
              <Trans>Failed to update feature flag. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Global defaults</Trans>}>
        {isError ? null : isLoading ? (
          <div {...stylex.props(page.loadingCenter)}>
            <Spinner label={t`Loading feature flags`} />
          </div>
        ) : !data || data.length === 0 ? (
          <EmptyState title={<Trans>No feature flags configured.</Trans>} />
        ) : (
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
        )}
      </ConsolePageSection>
    </ConsolePage>
  )
}
