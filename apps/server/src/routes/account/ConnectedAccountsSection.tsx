// Security 页的 Connected accounts:已绑定的社交账号可断开;租户启用但未绑定的可连接。
// 连接走 link 意图:回来后仍是本人,只多一个登录方式;结果通过 connected / connect_error 参数带回。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { Alert, Button, Skeleton } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { trackSocialDisconnected } from '../../lib/google-analytics-funnel'
import { useTheme } from '../../lib/theme'
import { authConfigQueryOptions } from '../sign-in/auth-config-query'
import { AccountRow, AccountSection, RowMeta } from './AccountPage'
import { surface } from './account-surface'
import { ConfirmDialog } from './ConfirmDialog'
import { OnlySignInMethodDialog } from './OnlySignInMethodDialog'
import { ProviderMark, providerName } from './provider-icons'
import { useDisconnectSocial, useSocialConnectionsQuery, useStartSocialLink } from './queries'
import { useStepUpGuard } from './step-up'
import type { SocialConnection } from './types'
import { errorCode, useActionError } from './use-security-action-error'

const RETURN_PATH = '/account/security'

type LinkResult = { connected?: string; connect_error?: string; provider?: string }

function ProviderTile({ provider }: { provider: string }): ReactNode {
  return (
    <span aria-hidden="true" {...stylex.props(surface.iconTile)}>
      <ProviderMark provider={provider} />
    </span>
  )
}

function LinkResultNotice({ result }: { result: LinkResult }): ReactNode {
  const { brand } = useTheme()
  const appName = brand.appName ?? 'XID'
  const provider = providerName(result.provider ?? '')
  if (result.connect_error === 'already_linked') {
    return (
      <Alert
        tone="error"
        title={
          <Trans>
            That {provider} account is already connected to another {appName} account
          </Trans>
        }
      >
        <Trans>
          Nothing changed on your account. Connect a different {provider} account, or disconnect
          this one from the other account first.
        </Trans>
      </Alert>
    )
  }
  if (result.connect_error === 'cancelled') {
    return (
      <Alert tone="info">
        <Trans>You didn't finish connecting {provider}. Nothing changed on your account.</Trans>
      </Alert>
    )
  }
  if (result.connect_error) {
    return (
      <Alert tone="error">
        <Trans>We couldn't connect {provider}. Nothing changed on your account. Try again.</Trans>
      </Alert>
    )
  }
  return null
}

function ConnectedRow({ connection }: { connection: SocialConnection }): ReactNode {
  const { t } = useLingui()
  const { brand } = useTheme()
  const disconnect = useDisconnectSocial()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [confirming, setConfirming] = useState(false)
  const [onlyMethod, setOnlyMethod] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = providerName(connection.provider)
  const account = connection.email ?? connection.providerAccountId
  const appName = brand.appName ?? 'XID'

  const handleDisconnect = async (): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => disconnect.mutateAsync(connection.id),
        <Trans>You're about to disconnect {name} from your account.</Trans>,
      )
      trackSocialDisconnected(connection.provider)
      setConfirming(false)
    } catch (err) {
      setConfirming(false)
      if (errorCode(err) === 'sign_in_method_required') {
        setOnlyMethod(true)
        return
      }
      setError(actionError(err, t`We couldn't disconnect ${name}. Try again.`))
    }
  }

  return (
    <>
      <AccountRow
        icon={<ProviderTile provider={connection.provider} />}
        title={name}
        meta={
          <>
            <RowMeta>{account}</RowMeta>
            {error ? <p {...stylex.props(surface.inlineError)}>{error}</p> : null}
          </>
        }
        actions={
          <Button
            variant="secondary"
            aria-label={t`Disconnect ${name}`}
            onClick={() => setConfirming(true)}
          >
            <Trans>Disconnect…</Trans>
          </Button>
        }
      />
      {confirming ? (
        <ConfirmDialog
          title={<Trans>Disconnect {name}?</Trans>}
          description={
            <Trans>
              You won't be able to sign in to {appName} with {account} anymore. You can connect it
              again later.
            </Trans>
          }
          confirmLabel={<Trans>Disconnect</Trans>}
          isLoading={disconnect.isPending}
          onConfirm={() => void handleDisconnect()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
      {onlyMethod ? (
        <OnlySignInMethodDialog
          title={<Trans>{name} is the only way you sign in</Trans>}
          consequence={
            <Trans>
              If you disconnect {account} now, you can't get back into {appName}.
            </Trans>
          }
          onClose={() => setOnlyMethod(false)}
        />
      ) : null}
    </>
  )
}

function ConnectRow({ provider, isGuest }: { provider: string; isGuest: boolean }): ReactNode {
  const { t } = useLingui()
  const startLink = useStartSocialLink()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const [error, setError] = useState<string | null>(null)
  const name = providerName(provider)

  const connect = async (): Promise<void> => {
    setError(null)
    // 访客走社交登录本身完成转正;正式用户走 link 意图,只关联不切换账号。
    if (isGuest) {
      const params = new URLSearchParams({ continue: RETURN_PATH })
      globalThis.location.assign(`/auth/${encodeURIComponent(provider)}/authorize?${params}`)
      return
    }
    try {
      const { url } = await guard(
        () => startLink.mutateAsync(provider),
        <Trans>You're about to connect {name} to your account.</Trans>,
      )
      globalThis.location.assign(url)
    } catch (err) {
      setError(actionError(err, t`We couldn't start connecting ${name}. Try again.`))
    }
  }

  return (
    <AccountRow
      icon={<ProviderTile provider={provider} />}
      title={name}
      meta={
        <>
          <RowMeta>
            <Trans>Not connected</Trans>
          </RowMeta>
          {error ? <p {...stylex.props(surface.inlineError)}>{error}</p> : null}
        </>
      }
      actions={
        <Button variant="secondary" isLoading={startLink.isPending} onClick={() => void connect()}>
          <Trans>Connect {name}</Trans>
        </Button>
      }
    />
  )
}

export function ConnectedAccountsSection(): ReactNode {
  const { api, user } = useAuth()
  const { brand } = useTheme()
  const search = useSearch({ strict: false }) as LinkResult
  const connections = useSocialConnectionsQuery()
  const authConfig = useQuery(authConfigQueryOptions({}, api))
  const appName = brand.appName ?? 'XID'
  const isGuest = isGuestUser(user)

  const connected = connections.data ?? []
  const connectedProviders = new Set(connected.map((item) => item.provider))
  const available = (authConfig.data?.socialProviders ?? [])
    .filter((item) => item.allowLogin && !connectedProviders.has(item.provider))
    .map((item) => item.provider)
  const justConnected = search.connected
    ? connected.find((item) => item.provider === search.connected)
    : undefined

  if (!connections.isPending && connected.length === 0 && available.length === 0) return null

  const description = justConnected ? (
    <Trans>
      {providerName(justConnected.provider)} is connected. You can now sign in with{' '}
      {justConnected.email ?? justConnected.providerAccountId} too.
    </Trans>
  ) : (
    <Trans>Use an account you already have to sign in to {appName}.</Trans>
  )

  return (
    <AccountSection title={<Trans>Connected accounts</Trans>} description={description}>
      {search.connect_error ? (
        <div {...stylex.props(surface.note)}>
          <LinkResultNotice result={search} />
        </div>
      ) : null}
      {connections.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="2.5rem" />
        </div>
      ) : connections.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your connected accounts. Refresh the page to try again.</Trans>
        </p>
      ) : (
        <>
          {connected.map((connection) => (
            <ConnectedRow key={connection.id} connection={connection} />
          ))}
          {available.map((provider) => (
            <ConnectRow key={provider} provider={provider} isGuest={isGuest} />
          ))}
        </>
      )}
    </AccountSection>
  )
}
