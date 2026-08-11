import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { account, consoleShell } from '../../styles/product-surface.stylex'
import { Alert, Button, EmptyState, Section, SectionRow, Skeleton } from '../../components/ui'
import { ConfirmDialog } from './ConfirmDialog'
import { trackSocialDisconnected } from '../../lib/google-analytics-funnel'
import { useDisconnectSocial, useSocialConnectionsQuery } from './queries'
import type { SocialConnection } from './hooks'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  microsoft: 'Microsoft',
  apple: 'Apple',
  facebook: 'Facebook',
  twitter: 'Twitter / X',
  linkedin: 'LinkedIn',
  discord: 'Discord',
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

const styles = stylex.create({
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  metaText: {
    margin: 0,
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  },
  errorText: {
    margin: '0.25rem 0 0',
    fontSize: '0.8125rem',
    color: tokens['--xid-danger'],
  },
  dangerAction: {
    color: tokens['--xid-danger'],
    fontSize: '0.8125rem',
    flexShrink: 0,
    transitionProperty: 'color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  skeletonList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  connectionList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
})

export default function ConnectionsPage(): ReactNode {
  const { t } = useLingui()
  const { data: connections, isPending, error } = useSocialConnectionsQuery()
  const disconnectSocial = useDisconnectSocial()

  const connectionList = connections ?? []

  if (isPending) {
    return (
      <div {...stylex.props(account.root)}>
        <div {...stylex.props(consoleShell.headerZone)}>
          <h1 {...stylex.props(consoleShell.displayTitle)}>
            <Trans>Connected accounts</Trans>
          </h1>
        </div>
        <div {...stylex.props(consoleShell.section)}>
          <div {...stylex.props(styles.skeletonList)}>
            <Skeleton height="3.5rem" />
            <Skeleton height="3.5rem" />
            <Skeleton height="3.5rem" />
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div {...stylex.props(account.root)}>
        <div {...stylex.props(consoleShell.headerZone)}>
          <h1 {...stylex.props(consoleShell.displayTitle)}>
            <Trans>Connected accounts</Trans>
          </h1>
        </div>
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error" title={<Trans>Failed to load connections</Trans>}>
            {error.longMessage || error.message || t`Failed to load connections`}
          </Alert>
        </div>
      </div>
    )
  }

  return (
    <div {...stylex.props(account.root)}>
      <div {...stylex.props(consoleShell.headerZone)}>
        <h1 {...stylex.props(consoleShell.displayTitle)}>
          <Trans>Connected accounts</Trans>
        </h1>
      </div>

      <div {...stylex.props(consoleShell.section)}>
        {connectionList.length === 0 ? (
          <ConnectionsEmpty />
        ) : (
          <Section label={<Trans>Connected accounts</Trans>}>
            <ul role="list" {...stylex.props(styles.connectionList)}>
              {connectionList.map((conn) => (
                <ConnectionItem
                  key={conn.id}
                  connection={conn}
                  disconnectMutate={disconnectSocial.mutateAsync}
                />
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  )
}

function ConnectionsEmpty(): ReactNode {
  return (
    <EmptyState
      title={<Trans>No social accounts connected</Trans>}
      description={<Trans>Link an account to enable social sign-in.</Trans>}
    />
  )
}

type ConnectionItemProps = {
  connection: SocialConnection
  disconnectMutate: (id: string) => Promise<unknown>
}

function ConnectionItem({ connection, disconnectMutate }: ConnectionItemProps): ReactNode {
  const { t } = useLingui()
  const [showConfirm, setShowConfirm] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const label = providerLabel(connection.provider)

  const handleDisconnect = async (): Promise<void> => {
    setIsDisconnecting(true)
    try {
      await disconnectMutate(connection.id)
      trackSocialDisconnected(connection.provider)
      setShowConfirm(false)
    } catch (err) {
      const xidErr = err as { message?: string; longMessage?: string }
      setError(xidErr.longMessage || xidErr.message || t`Failed to disconnect account.`)
      setShowConfirm(false)
    } finally {
      setIsDisconnecting(false)
    }
  }

  return (
    <li>
      <SectionRow
        label={label}
        action={
          <Button
            variant="ghost"
            onClick={() => setShowConfirm(true)}
            aria-label={t`Disconnect ${label}`}
            {...stylex.props(styles.dangerAction)}
          >
            <Trans>Disconnect</Trans>
          </Button>
        }
      >
        {connection.email ? <p {...stylex.props(styles.metaText)}>{connection.email}</p> : null}
        <p {...stylex.props(styles.metaText)}>
          <Trans>Connected</Trans> {new Date(connection.connectedAt).toLocaleDateString()}
        </p>
        {error ? (
          <p role="alert" {...stylex.props(styles.errorText)}>
            {error}
          </p>
        ) : null}
      </SectionRow>

      {showConfirm ? (
        <ConfirmDialog
          title={<Trans>Disconnect {label}?</Trans>}
          description={
            <Trans>
              This will remove the link between your account and {label}. You will no longer be able
              to sign in with {label} unless you reconnect it.
            </Trans>
          }
          confirmLabel={<Trans>Disconnect</Trans>}
          isLoading={isDisconnecting}
          onConfirm={() => void handleDisconnect()}
          onCancel={() => setShowConfirm(false)}
        />
      ) : null}
    </li>
  )
}
