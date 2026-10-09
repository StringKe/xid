// Security 页的 Passkeys 区:没有 passkey 时是引导卡片;有时按「设备上」与「安全密钥上」分组,
// 每个 passkey 一张卡片,FIDO 三段说明常驻。删除最后一个时写明之后用什么登录,删除后通知凭据管理器。

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Skeleton } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { authConfigQueryOptions } from '../sign-in/auth-config-query'
import { AccountSection } from './AccountPage'
import { surface } from './account-surface'
import { OnlySignInMethodDialog } from './OnlySignInMethodDialog'
import { PasskeyCard } from './PasskeyCard'
import { RemovePasskeyDialog, RenamePasskeyDialog } from './PasskeyDialogs'
import { PasskeyExplainer, PasskeyHero } from './PasskeyIntro'
import {
  EarlierAddressNotice,
  PasskeyLimitNotice,
  RemovedNotice,
  ReregistrationNotice,
} from './PasskeyNotices'
import { usePasskeyReregistrationNotice } from './passkey-reregistration'
import { isSecurityKey, passkeyStyles as styles } from './passkey-section-styles'
import { signalPasskeyState } from './passkey-signal'
import { usePasskeySignalData, usePasskeysQuery } from './queries'
import type { PasskeyCredential } from './types'
import { usePasskeyRegistration } from './use-passkey-registration'

function oldestPasskey(list: readonly PasskeyCredential[]): PasskeyCredential | undefined {
  return [...list].sort((a, b) =>
    (a.lastUsedAt ?? a.createdAt).localeCompare(b.lastUsedAt ?? b.createdAt),
  )[0]
}

export function PasskeySection(): ReactNode {
  const { api } = useAuth()
  const passkeys = usePasskeysQuery()
  const authConfig = useQuery(authConfigQueryOptions({}, api))
  const signalData = usePasskeySignalData()
  const reregistration = usePasskeyReregistrationNotice(
    authConfig.data?.passkeyEntry.reregistrationRequired ?? false,
  )
  const [renaming, setRenaming] = useState<PasskeyCredential | null>(null)
  const [removing, setRemoving] = useState<PasskeyCredential | null>(null)
  const [removedName, setRemovedName] = useState<string | null>(null)
  const [onlyMethod, setOnlyMethod] = useState(false)
  const registration = usePasskeyRegistration({
    onStart: () => setRemovedName(null),
    onRegistered: () => reregistration.dismiss(),
  })

  const list = passkeys.data?.data ?? []
  const limit = passkeys.data?.limit ?? 10
  const passkeyMethod = authConfig.data?.methods.passkey
  const canCreate = passkeyMethod ? passkeyMethod.enabled && passkeyMethod.allowLogin : false
  const atLimit = list.length >= limit
  const count = list.length
  const host = globalThis.location?.hostname ?? ''
  const earlierHost = authConfig.data?.earlierPasskeyRpId ?? null
  const hasEarlier = earlierHost !== null && list.some((passkey) => passkey.earlier)
  const oldest = oldestPasskey(list)
  const create = (options: { securityKey: boolean }): void => void registration.register(options)

  // 只是提示凭据管理器同步,失败不影响账户里已完成的改动。
  const signal = (): void => {
    signalData.mutate(undefined, {
      onSuccess: (data) => {
        signalPasskeyState(data).catch((error: unknown) => {
          console.warn('passkey signal failed', error)
        })
      },
    })
  }

  const cards = (items: PasskeyCredential[]): ReactNode => (
    <ul {...stylex.props(styles.cards)}>
      {items.map((passkey) => (
        <PasskeyCard
          key={passkey.id}
          passkey={passkey}
          onRename={setRenaming}
          onRemove={setRemoving}
        />
      ))}
    </ul>
  )
  const deviceKeys = list.filter((passkey) => !isSecurityKey(passkey))
  const securityKeys = list.filter(isSecurityKey)

  return (
    <AccountSection
      title={<Trans>Passkeys</Trans>}
      description={
        passkeys.isPending ? null : count === 0 ? (
          <Trans>None yet</Trans>
        ) : (
          <Trans>
            {count} of {limit} passkeys
          </Trans>
        )
      }
      action={
        count > 0 && canCreate ? (
          <Button
            variant="accent"
            disabled={atLimit}
            isLoading={registration.isPending}
            onClick={() => create({ securityKey: false })}
          >
            <Trans>Create a passkey</Trans>
          </Button>
        ) : null
      }
    >
      {reregistration.visible ? <ReregistrationNotice onDismiss={reregistration.dismiss} /> : null}
      {hasEarlier && earlierHost ? (
        <EarlierAddressNotice earlierHost={earlierHost} host={host} />
      ) : null}
      {atLimit && oldest ? <PasskeyLimitNotice limit={limit} oldest={oldest} /> : null}
      {passkeys.isPending ? (
        <div {...stylex.props(surface.skeletonStack)}>
          <Skeleton height="5rem" />
          <Skeleton height="5rem" />
        </div>
      ) : passkeys.error ? (
        <p {...stylex.props(surface.note)}>
          <Trans>We couldn't load your passkeys. Refresh the page to try again.</Trans>
        </p>
      ) : count === 0 && !canCreate ? (
        authConfig.data ? (
          <p {...stylex.props(surface.note)}>
            <Trans>Your organization doesn't offer passkeys yet.</Trans>
          </p>
        ) : null
      ) : count === 0 ? (
        <PasskeyHero pendingSecurityKey={registration.pendingSecurityKey} onCreate={create} />
      ) : null}
      {registration.error ? (
        <div {...stylex.props(surface.note)}>
          <Alert tone="error">{registration.error}</Alert>
        </div>
      ) : null}
      {removedName ? <RemovedNotice name={removedName} /> : null}
      {count === 0 && !canCreate ? null : <PasskeyExplainer host={host} />}
      {deviceKeys.length > 0 ? (
        <>
          <h3 {...stylex.props(surface.subheading)}>
            <Trans>Passkeys on your devices</Trans>
          </h3>
          {cards(deviceKeys)}
        </>
      ) : null}
      {securityKeys.length > 0 ? (
        <>
          <h3 {...stylex.props(surface.subheading)}>
            <Trans>Passkeys on security keys</Trans>
          </h3>
          {cards(securityKeys)}
        </>
      ) : null}
      {renaming ? (
        <RenamePasskeyDialog
          passkey={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={signal}
        />
      ) : null}
      {removing ? (
        <RemovePasskeyDialog
          passkey={removing}
          isLast={count === 1}
          onClose={() => setRemoving(null)}
          onRemoved={(name) => {
            setRemovedName(name)
            signal()
          }}
          onOnlyMethod={() => setOnlyMethod(true)}
        />
      ) : null}
      {onlyMethod ? (
        <OnlySignInMethodDialog
          title={<Trans>This passkey is the only way you sign in</Trans>}
          consequence={<Trans>If you remove it now, you can't get back into your account.</Trans>}
          onClose={() => setOnlyMethod(false)}
        />
      ) : null}
    </AccountSection>
  )
}
