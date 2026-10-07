// 一次性 client secret 展示,与轮换前的确认(列出会立即受影响的回调域名)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { Alert, Button, Dialog, OneTimeSecret } from '@xid-kit/web-ui/ui'
import type { AppRecord } from './app-api'
import { useRotateSecret } from './app-api'
import { redirectHosts } from './app-format'

const styles = stylex.create({
  hosts: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  host: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '0.5rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    fontSize: text.sm,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  hostName: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    overflowWrap: 'anywhere',
  },
  muted: {
    margin: 0,
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  subhead: {
    margin: 0,
    fontSize: text.sm,
    fontWeight: 600,
  },
})

export function SecretRevealDialog({
  appName,
  secret,
  rotated,
  onDone,
}: {
  appName: string
  secret: string
  rotated: boolean
  onDone: () => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <Dialog
      open
      dismissible={false}
      onOpenChange={() => undefined}
      title={
        rotated ? (
          <Trans>Copy the new {appName} secret</Trans>
        ) : (
          <Trans>Copy the {appName} secret</Trans>
        )
      }
      description={
        <Trans>
          This is the only time XID shows it. Store it in the server configuration of {appName}, not
          in browser code or a repository.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
    >
      {rotated ? (
        <Alert
          tone="warning"
          title={<Trans>The previous secret stopped working when you rotated.</Trans>}
        >
          <Trans>
            Until you deploy this one, token requests from {appName} fail with invalid_client.
          </Trans>
        </Alert>
      ) : null}
      <OneTimeSecret
        label={<Trans>Client secret</Trans>}
        value={secret}
        subject={t`client secret`}
        savedLabel={<Trans>I saved the secret somewhere safe</Trans>}
        onDone={onDone}
      />
    </Dialog>
  )
}

export function RotateSecretDialog({
  app,
  onClose,
  onRotated,
}: {
  app: AppRecord
  onClose: () => void
  onRotated: (secret: string) => void
}): ReactNode {
  const errorMessage = useManagementErrorMessage()
  const rotate = useRotateSecret(app.id)
  const name = app.name
  const hosts = redirectHosts(app)
  return (
    <Dialog
      open
      onOpenChange={(next) => (next || rotate.isPending ? undefined : onClose())}
      title={<Trans>Rotate the {name} secret?</Trans>}
      description={
        <Trans>
          XID creates a new secret and shows it once. The current secret stops working right away,
          so sign-ins to {name} fail until you deploy the new one.
        </Trans>
      }
      size="md"
      footer={
        <>
          <Button variant="secondary" disabled={rotate.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            isLoading={rotate.isPending}
            onClick={() =>
              rotate.mutate(undefined, { onSuccess: (result) => onRotated(result.client_secret) })
            }
          >
            <Trans>Rotate secret</Trans>
          </Button>
        </>
      }
    >
      {hosts.length > 0 ? (
        <>
          <p {...stylex.props(styles.subhead)}>
            <Trans>Affected right away</Trans>
          </p>
          <ul {...stylex.props(styles.hosts)}>
            {hosts.map((host) => (
              <li key={host} {...stylex.props(styles.host)}>
                <span {...stylex.props(styles.hostName)}>{host}</span>
                <span {...stylex.props(styles.muted)}>
                  <Trans>Code exchange fails</Trans>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p {...stylex.props(styles.muted)}>
        <Trans>
          Users who are already signed in stay signed in until their access token expires.
        </Trans>
      </p>
      {rotate.error ? <Alert tone="error">{errorMessage(rotate.error)}</Alert> : null}
    </Dialog>
  )
}
