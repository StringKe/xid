// 轮换第 3 步:next key 发布满一个 JWKS 缓存周期后才能设为 active;服务端要求 step-up,
// 收到 step_up_required 时去 Core /mfa 重新验证,带 confirm=activate&kid= 回来重新打开确认框。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { Alert, Badge, Button, Skeleton, useToast } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { formatDate, formatDateTime } from '../../lib/date-format'
import { stepUpUrl } from '../users/DeleteUserDialog'
import { useActivateSigningKey } from './settings-queries'
import type { PlatformSigningKey, SigningKeyStatus } from './settings-queries'

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flex: '1 1 16rem',
    minWidth: 0,
  },
  heading: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
  },
  kid: {
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    lineHeight: leading.sm,
    overflowWrap: 'anywhere',
  },
  kidRetiring: {
    color: tokens['--xid-muted-foreground'],
  },
  detail: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  action: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.25rem',
  },
  stepUp: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    padding: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  stepUpText: {
    margin: 0,
    flex: '1 1 14rem',
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
})

const STATUS_TONES: Record<SigningKeyStatus, BadgeTone> = {
  next: 'info',
  active: 'success',
  retiring: 'neutral',
}

function useStatusLabel(): (status: SigningKeyStatus) => string {
  const { t } = useLingui()
  return (status) => {
    if (status === 'next') return t`Next`
    if (status === 'active') return t`Active`
    return t`Retiring`
  }
}

// next key 的可激活时间到达时重新渲染,按钮随之解锁。
function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null || until <= now) return
    const timer = globalThis.setTimeout(() => setNow(Date.now()), until - now + 500)
    return () => globalThis.clearTimeout(timer)
  }, [until, now])
  return now
}

function KeyDetail({ signingKey }: { signingKey: PlatformSigningKey }): ReactNode {
  const { i18n } = useLingui()
  const published = formatDate(i18n, signingKey.createdAt)
  const since = formatDate(i18n, signingKey.activatedAt)
  const leaves = formatDate(i18n, signingKey.retireAfter)
  if (signingKey.status === 'next') {
    return <Trans>Published {published}. In JWKS, not signing yet.</Trans>
  }
  if (signingKey.status === 'active') {
    return since ? <Trans>Signing since {since}.</Trans> : <Trans>Signing new tokens.</Trans>
  }
  return leaves ? (
    <Trans>Verifies older tokens. Leaves JWKS on {leaves}.</Trans>
  ) : (
    <Trans>Verifies older tokens.</Trans>
  )
}

function returnPathWithConfirm(kid: string): string {
  const { pathname, search } = globalThis.location
  const params = new URLSearchParams(search)
  params.set('section', 'signing-keys')
  params.set('confirm', 'activate')
  params.set('kid', kid)
  return `${pathname}?${params.toString()}`
}

function ActivateDialog({
  signingKey,
  previous,
  onClose,
}: {
  signingKey: PlatformSigningKey
  previous: PlatformSigningKey | null
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const activate = useActivateSigningKey()
  const kid = signingKey.kid
  const previousKid = previous?.kid ?? null
  const needsStepUp = activate.error?.code === 'step_up_required'

  return (
    <ConfirmDialog
      title={<Trans>Make {kid} the active key?</Trans>}
      description={
        previousKid ? (
          <Trans>
            New tokens are signed with {kid} right away. {previousKid} keeps verifying the tokens it
            already signed until they expire, then leaves JWKS.
          </Trans>
        ) : (
          <Trans>New tokens are signed with {kid} right away.</Trans>
        )
      }
      confirmLabel={<Trans>Make active</Trans>}
      confirmVariant="primary"
      isLoading={activate.isPending}
      error={activate.error && !needsStepUp ? errorMessage(activate.error) : undefined}
      onConfirm={() =>
        activate.mutate(
          { kid },
          {
            onSuccess: () => {
              notify({ title: t`${kid} is now the active key` })
              onClose()
            },
          },
        )
      }
      onCancel={onClose}
    >
      {needsStepUp ? (
        <div {...stylex.props(styles.stepUp)}>
          <p {...stylex.props(styles.stepUpText)}>
            <Trans>
              Changing the signing key needs a fresh check that it is you. It stays valid for 5
              minutes.
            </Trans>
          </p>
          <Button
            variant="secondary"
            onClick={() => globalThis.location.assign(stepUpUrl(returnPathWithConfirm(kid)))}
          >
            <Trans>Confirm it is you</Trans>
          </Button>
        </div>
      ) : null}
    </ConfirmDialog>
  )
}

export function SigningKeysSection({
  keys,
  isLoading,
  isError,
}: {
  keys: readonly PlatformSigningKey[] | undefined
  isLoading: boolean
  isError: boolean
}): ReactNode {
  const { i18n } = useLingui()
  const statusLabel = useStatusLabel()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const next = keys?.find((key) => key.status === 'next') ?? null
  const previous = keys?.find((key) => key.status === 'active') ?? null
  const now = useNow(next?.activatableAt ?? null)
  const requestedKid = params.get('confirm') === 'activate' ? params.get('kid') : null
  const [dialogKid, setDialogKid] = useState<string | null>(requestedKid)
  const dialogKey = keys?.find((key) => key.kid === dialogKid && key.status === 'next') ?? null

  useEffect(() => {
    if (requestedKid) setDialogKid(requestedKid)
  }, [requestedKid])

  function closeDialog(): void {
    setDialogKid(null)
    if (!requestedKid) return
    const nextParams = new URLSearchParams(params)
    nextParams.delete('confirm')
    nextParams.delete('kid')
    navigate(`${location.pathname}?${nextParams.toString()}`, { replace: true })
  }

  if (isError) {
    return (
      <Alert tone="error">
        <Trans>Failed to load signing keys.</Trans>
      </Alert>
    )
  }
  if (isLoading || !keys) return <Skeleton height="10rem" />
  if (keys.length === 0) {
    return (
      <p {...stylex.props(styles.detail)}>
        <Trans>No signing keys are published. Run the bootstrap for this instance.</Trans>
      </p>
    )
  }

  return (
    <>
      <ul {...stylex.props(styles.list)}>
        {keys.map((signingKey) => {
          const readyAt = signingKey.activatableAt
          const isWaiting = readyAt !== null && readyAt > now
          const readyTime = formatDateTime(i18n, readyAt)
          return (
            <li key={signingKey.kid} {...stylex.props(styles.row)}>
              <div {...stylex.props(styles.body)}>
                <div {...stylex.props(styles.heading)}>
                  <span
                    {...stylex.props(
                      styles.kid,
                      signingKey.status === 'retiring' && styles.kidRetiring,
                    )}
                  >
                    {signingKey.kid}
                  </span>
                  <Badge tone={STATUS_TONES[signingKey.status]}>
                    {statusLabel(signingKey.status)}
                  </Badge>
                </div>
                <p {...stylex.props(styles.detail)}>
                  <KeyDetail signingKey={signingKey} />
                </p>
              </div>
              {signingKey.status === 'next' ? (
                <div {...stylex.props(styles.action)}>
                  <Button
                    variant="secondary"
                    aria-disabled={isWaiting || undefined}
                    onClick={() => {
                      if (!isWaiting) setDialogKid(signingKey.kid)
                    }}
                  >
                    <Trans>Make active…</Trans>
                  </Button>
                  {isWaiting ? (
                    <p {...stylex.props(styles.detail)}>
                      <Trans>Ready at {readyTime}, after apps refresh their key cache.</Trans>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {dialogKey ? (
        <ActivateDialog signingKey={dialogKey} previous={previous} onClose={closeDialog} />
      ) : null}
    </>
  )
}
