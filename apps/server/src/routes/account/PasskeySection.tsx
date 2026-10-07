// Security 页的 Passkeys 区:没有 passkey 时是引导卡片;有时按「设备上」与「安全密钥上」分组,
// 每个 passkey 一张卡片,FIDO 三段说明常驻。删除最后一个时写明之后用什么登录,删除后通知凭据管理器。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useQuery } from '@tanstack/react-query'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Dropdown,
  Icon,
  Notice,
  Skeleton,
  TextField,
} from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackPasskeyRegistered } from '../../lib/google-analytics-funnel'
import { useAccountBrand } from './use-account-brand'
import { tokens } from '../../styles/tokens.stylex'
import { authConfigQueryOptions } from '../sign-in/auth-config-query'
import { useDefaultPasskeyName } from '../../components/hosted/passkey-name'
import { AccountSection } from './AccountPage'
import { AccountIcon } from './account-icons'
import { useAccountDates } from './account-format'
import { surface } from './account-surface'
import { OnlySignInMethodDialog } from './OnlySignInMethodDialog'
import { usePasskeyReregistrationNotice } from './passkey-reregistration'
import { signalPasskeyState } from './passkey-signal'
import {
  useMfaFactorsQuery,
  usePasskeySignalData,
  usePasskeysQuery,
  useRegisterPasskey,
  useRemovePasskey,
  useRenamePasskey,
  useSocialConnectionsQuery,
} from './queries'
import { useStepUpGuard } from './step-up'
import type { PasskeyCredential } from './types'
import { errorCode, useActionError } from './use-security-action-error'

const SECURITY_KEY_TRANSPORTS = new Set(['usb', 'nfc', 'ble'])

const styles = stylex.create({
  explainer: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 40rem)': 'repeat(3, 1fr)' },
    gap: { default: '0.75rem', '@media (min-width: 40rem)': '1.25rem' },
    paddingBlock: '1rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  explainerTitle: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  explainerBody: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
  hero: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.75rem',
    marginBlockStart: '1rem',
    padding: { default: '1.25rem', '@media (min-width: 48rem)': '1.5rem' },
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  heroTitle: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
    color: tokens['--xid-fg'],
  },
  heroBody: {
    margin: 0,
    fontSize: text.base,
    lineHeight: '1.375rem',
    color: tokens['--xid-muted-foreground'],
  },
  heroActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  cards: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    padding: '1rem',
    borderRadius: tokens['--xid-radius-lg'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    backgroundColor: tokens['--xid-surface'],
    minWidth: 0,
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    minWidth: 0,
  },
  cardActions: {
    display: { default: 'none', '@media (min-width: 40rem)': 'flex' },
    gap: '0.25rem',
    flexShrink: 0,
  },
  cardMenu: {
    display: { default: 'flex', '@media (min-width: 40rem)': 'none' },
    flexShrink: 0,
  },
  menuTrigger: {
    width: '2.75rem',
    height: '2.75rem',
    justifyContent: 'center',
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    boxShadow: 'none',
  },
  limit: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    marginBlockStart: '0.75rem',
    padding: '0.875rem 1rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  limitTitle: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.medium,
  },
  removedCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  consequence: {
    margin: 0,
    fontSize: text.base,
    lineHeight: '1.375rem',
    color: tokens['--xid-fg'],
  },
  fineprint: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
})

function isSecurityKey(passkey: PasskeyCredential): boolean {
  const transports = passkey.transports
  return (
    transports.some((transport) => SECURITY_KEY_TRANSPORTS.has(transport)) &&
    !transports.includes('internal') &&
    !transports.includes('hybrid')
  )
}

// 浏览器取消或超时(NotAllowedError)静默;已在本设备注册过时给出具体提示。
function registrationErrorMessage(
  err: unknown,
  messages: { duplicate: string; fallback: string },
): string | null | undefined {
  if (!(err instanceof DOMException)) return undefined
  if (err.name === 'NotAllowedError' || err.name === 'AbortError') return null
  if (err.name === 'InvalidStateError') return messages.duplicate
  return messages.fallback
}

function PasskeyIcon({ passkey }: { passkey: PasskeyCredential }): ReactNode {
  return (
    <span aria-hidden="true" {...stylex.props(surface.iconTile)}>
      <AccountIcon name={isSecurityKey(passkey) ? 'securityKey' : 'devices'} />
    </span>
  )
}

function PasskeyMeta({ passkey }: { passkey: PasskeyCredential }): ReactNode {
  const dates = useAccountDates()
  const created = dates.date(passkey.createdAt)
  const lastUsed = passkey.lastUsedAt ? dates.dateTime(passkey.lastUsedAt) : null
  return (
    <>
      <p {...stylex.props(surface.rowMeta)}>
        <Trans>Created {created}</Trans>
      </p>
      <p {...stylex.props(surface.rowMeta)}>
        {lastUsed ? <Trans>Last used {lastUsed}</Trans> : <Trans>Not used yet</Trans>}
      </p>
    </>
  )
}

function passkeyName(passkey: PasskeyCredential, fallback: string): string {
  return passkey.deviceName || fallback
}

type CardProps = {
  passkey: PasskeyCredential
  onRename: (passkey: PasskeyCredential) => void
  onRemove: (passkey: PasskeyCredential) => void
}

function PasskeyCard({ passkey, onRename, onRemove }: CardProps): ReactNode {
  const { t } = useLingui()
  const name = passkeyName(passkey, t`Passkey`)
  return (
    <li {...stylex.props(styles.card)}>
      <PasskeyIcon passkey={passkey} />
      <div {...stylex.props(styles.cardBody)}>
        <div {...stylex.props(surface.rowTitleLine)}>
          <span {...stylex.props(surface.rowTitle)}>{name}</span>
          {passkey.backedUp ? null : (
            <Badge>
              <Trans>Not synced</Trans>
            </Badge>
          )}
        </div>
        <PasskeyMeta passkey={passkey} />
      </div>
      <div {...stylex.props(styles.cardActions)}>
        <button
          type="button"
          aria-label={t`Rename ${name}`}
          onClick={() => onRename(passkey)}
          {...stylex.props(surface.quietButton)}
        >
          <Trans>Rename…</Trans>
        </button>
        <button
          type="button"
          aria-label={t`Remove ${name}`}
          onClick={() => onRemove(passkey)}
          {...stylex.props(surface.quietButton)}
        >
          <Trans>Remove…</Trans>
        </button>
      </div>
      <div {...stylex.props(styles.cardMenu)}>
        <Dropdown
          ariaLabel={t`Actions for ${name}`}
          align="end"
          triggerStyle={styles.menuTrigger}
          trigger={<Icon name="more-horizontal" size={16} />}
          items={[
            { key: 'rename', label: <Trans>Rename…</Trans>, onSelect: () => onRename(passkey) },
            {
              key: 'remove',
              label: <Trans>Remove…</Trans>,
              tone: 'danger',
              onSelect: () => onRemove(passkey),
            },
          ]}
        />
      </div>
    </li>
  )
}

function RenamePasskeyDialog({
  passkey,
  onClose,
  onRenamed,
}: {
  passkey: PasskeyCredential
  onClose: () => void
  onRenamed: () => void
}): ReactNode {
  const { t } = useLingui()
  const rename = useRenamePasskey()
  const actionError = useActionError()
  const [open, setOpen] = useState(true)
  const [name, setName] = useState(passkey.deviceName ?? '')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError(null)
    try {
      await rename.mutateAsync({ id: passkey.id, deviceName: name.trim() })
      onRenamed()
      setOpen(false)
    } catch (err) {
      setError(actionError(err, t`We couldn't rename this passkey. Try again.`))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !rename.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={<Trans>Rename passkey</Trans>}
      description={<Trans>Pick a name you'll recognize, like the device it's saved on.</Trans>}
      footer={
        <>
          <Button variant="secondary" disabled={rename.isPending} onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="accent" type="submit" form="rename-passkey" isLoading={rename.isPending}>
            <Trans>Save name</Trans>
          </Button>
        </>
      }
    >
      <form id="rename-passkey" onSubmit={(event) => void handleSubmit(event)}>
        <TextField
          label={<Trans>Name</Trans>}
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </form>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}

function useRemainingSignInDescription(): ReactNode {
  const { user } = useAuth()
  const factors = useMfaFactorsQuery()
  const social = useSocialConnectionsQuery()
  const appName = useAccountBrand().name
  const hasTotp = factors.data?.some((factor) => factor.type === 'totp') ?? false
  const provider = social.data?.[0]?.provider
  if (user?.hasPassword && hasTotp) {
    return (
      <Trans>
        After this, you'll sign in to {appName} with your password and a code from your
        authenticator app.
      </Trans>
    )
  }
  if (user?.hasPassword) {
    return <Trans>After this, you'll sign in to {appName} with your password.</Trans>
  }
  if (provider) {
    return (
      <Trans>
        After this, you'll sign in to {appName} with your {provider} account.
      </Trans>
    )
  }
  return <Trans>After this, you'll sign in to {appName} with a code sent to your email.</Trans>
}

function RemovePasskeyDialog({
  passkey,
  isLast,
  onClose,
  onRemoved,
  onOnlyMethod,
}: {
  passkey: PasskeyCredential
  isLast: boolean
  onClose: () => void
  onRemoved: (name: string) => void
  onOnlyMethod: () => void
}): ReactNode {
  const { t } = useLingui()
  const remove = useRemovePasskey()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const remaining = useRemainingSignInDescription()
  const [open, setOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const name = passkeyName(passkey, t`Passkey`)
  const appName = useAccountBrand().name

  const handleRemove = async (): Promise<void> => {
    setError(null)
    try {
      await guard(
        () => remove.mutateAsync(passkey.id),
        <Trans>You're about to remove the passkey {name}.</Trans>,
      )
      onRemoved(name)
      setOpen(false)
    } catch (err) {
      if (errorCode(err) === 'sign_in_method_required') {
        setOpen(false)
        onOnlyMethod()
        return
      }
      setError(actionError(err, t`We couldn't remove this passkey. Try again.`))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !remove.isPending) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={isLast ? <Trans>Remove your only passkey?</Trans> : <Trans>Remove {name}?</Trans>}
      footer={
        <>
          <Button variant="secondary" disabled={remove.isPending} onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="danger" isLoading={remove.isPending} onClick={() => void handleRemove()}>
            <Trans>Remove passkey</Trans>
          </Button>
        </>
      }
    >
      <div {...stylex.props(styles.removedCard)}>
        <PasskeyIcon passkey={passkey} />
        <div {...stylex.props(styles.cardBody)}>
          <span {...stylex.props(surface.rowTitle)}>{name}</span>
          <PasskeyMeta passkey={passkey} />
        </div>
      </div>
      {isLast ? <p {...stylex.props(styles.consequence)}>{remaining}</p> : null}
      <p {...stylex.props(styles.fineprint)}>
        <Trans>
          This only removes it from your {appName} account. The passkey stays in the password
          manager or on the security key where you created it until you delete it there.
        </Trans>
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}

export function PasskeySection(): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const passkeys = usePasskeysQuery()
  const authConfig = useQuery(authConfigQueryOptions({}, api))
  const registerPasskey = useRegisterPasskey()
  const signalData = usePasskeySignalData()
  const guard = useStepUpGuard()
  const actionError = useActionError()
  const dates = useAccountDates()
  const defaultDeviceName = useDefaultPasskeyName()
  const reregistration = usePasskeyReregistrationNotice(
    authConfig.data?.passkeyEntry.reregistrationRequired ?? false,
  )
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<PasskeyCredential | null>(null)
  const [removing, setRemoving] = useState<PasskeyCredential | null>(null)
  const [removedName, setRemovedName] = useState<string | null>(null)
  const [onlyMethod, setOnlyMethod] = useState(false)

  const list = passkeys.data?.data ?? []
  const limit = passkeys.data?.limit ?? 10
  const passkeyMethod = authConfig.data?.methods.passkey
  const canCreate = passkeyMethod ? passkeyMethod.enabled && passkeyMethod.allowLogin : false
  const atLimit = list.length >= limit
  const count = list.length
  const host = globalThis.location?.hostname ?? ''

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

  const handleRegister = async (securityKey: boolean): Promise<void> => {
    setRegisterError(null)
    setRemovedName(null)
    try {
      await guard(
        () => registerPasskey.mutateAsync({ deviceName: defaultDeviceName, securityKey }),
        <Trans>You're about to add a passkey to your account.</Trans>,
      )
      trackPasskeyRegistered()
    } catch (err) {
      const fallback = t`The passkey wasn't created. Try again.`
      const browserMessage = registrationErrorMessage(err, {
        duplicate: t`This device already has a passkey for your account.`,
        fallback,
      })
      setRegisterError(browserMessage === undefined ? actionError(err, fallback) : browserMessage)
      return
    }
    reregistration.dismiss()
  }

  const deviceKeys = list.filter((passkey) => !isSecurityKey(passkey))
  const securityKeys = list.filter(isSecurityKey)
  const oldest = [...list].sort((a, b) =>
    (a.lastUsedAt ?? a.createdAt).localeCompare(b.lastUsedAt ?? b.createdAt),
  )[0]

  const createButton =
    count > 0 && canCreate ? (
      <Button
        variant="accent"
        disabled={atLimit}
        isLoading={registerPasskey.isPending}
        onClick={() => void handleRegister(false)}
      >
        <Trans>Create a passkey</Trans>
      </Button>
    ) : null

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
      action={createButton}
    >
      {reregistration.visible ? (
        <div {...stylex.props(surface.note)}>
          <Notice
            tone="info"
            action={
              <Button variant="ghost" onClick={reregistration.dismiss}>
                <Trans>Dismiss</Trans>
              </Button>
            }
          >
            <Trans>
              Passkeys created on a different address don't work here. Create one for this address
              to keep signing in with a passkey.
            </Trans>
          </Notice>
        </div>
      ) : null}
      {atLimit && oldest ? (
        <div {...stylex.props(styles.limit)}>
          <p {...stylex.props(styles.limitTitle)}>
            <Trans>You've reached the limit of {limit} passkeys</Trans>
          </p>
          <p {...stylex.props(surface.rowMeta)}>
            <Trans>
              Remove one you no longer use first. {passkeyName(oldest, t`Passkey`)} was last used on{' '}
              {dates.date(oldest.lastUsedAt ?? oldest.createdAt)}.
            </Trans>
          </p>
        </div>
      ) : null}
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
        <div {...stylex.props(styles.hero)}>
          <h3 {...stylex.props(styles.heroTitle)}>
            <Trans>Use your face or fingerprint to sign in</Trans>
          </h3>
          <p {...stylex.props(styles.heroBody)}>
            <Trans>
              A passkey replaces your password and counts as two-step verification. It takes a few
              seconds on this device.
            </Trans>
          </p>
          <div {...stylex.props(styles.heroActions)}>
            <Button
              variant="accent"
              isLoading={registerPasskey.isPending && !registerPasskey.variables?.securityKey}
              onClick={() => void handleRegister(false)}
            >
              <Trans>Create a passkey</Trans>
            </Button>
            <Button
              variant="secondary"
              isLoading={
                registerPasskey.isPending && registerPasskey.variables?.securityKey === true
              }
              onClick={() => void handleRegister(true)}
            >
              <Trans>Use a security key</Trans>
            </Button>
          </div>
        </div>
      ) : null}
      {registerError ? (
        <div {...stylex.props(surface.note)}>
          <Alert tone="error">{registerError}</Alert>
        </div>
      ) : null}
      {removedName ? (
        <div {...stylex.props(surface.note)}>
          <Notice tone="success">
            <Trans>
              {removedName} was removed. If your password manager still offers it, delete it there
              too.
            </Trans>
          </Notice>
        </div>
      ) : null}
      {count === 0 && !canCreate ? null : (
        <div {...stylex.props(styles.explainer)}>
          <div>
            <p {...stylex.props(styles.explainerTitle)}>
              <Trans>What they are</Trans>
            </p>
            <p {...stylex.props(styles.explainerBody)}>
              <Trans>
                You sign in with your fingerprint, face or screen lock instead of a password.
              </Trans>
            </p>
          </div>
          <div>
            <p {...stylex.props(styles.explainerTitle)}>
              <Trans>Why use them</Trans>
            </p>
            <p {...stylex.props(styles.explainerBody)}>
              <Trans>
                A passkey only works on {host}, so a look-alike sign-in page can't use it.
              </Trans>
            </p>
          </div>
          <div>
            <p {...stylex.props(styles.explainerTitle)}>
              <Trans>Where they're saved</Trans>
            </p>
            <p {...stylex.props(styles.explainerBody)}>
              <Trans>
                In your password manager or on a security key. Anyone who can unlock that device can
                sign in.
              </Trans>
            </p>
          </div>
        </div>
      )}
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
