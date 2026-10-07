import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  Section,
  SectionRow,
  Skeleton,
} from '../../components/ui'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../lib/auth-context'
import { trackPasskeyRegistered } from '../../lib/google-analytics-funnel'
import { authConfigQueryOptions } from '../sign-in/auth-config-query'
import { ConfirmDialog } from './ConfirmDialog'
import { useDefaultPasskeyName } from '../../components/hosted/passkey-name'
import { usePasskeyReregistrationNotice } from './passkey-reregistration'
import { usePasskeysQuery, useRegisterPasskey, useRemovePasskey, useRenamePasskey } from './queries'
import type { PasskeyCredential } from './types'
import { useSecurityActionError } from './use-security-action-error'

const styles = stylex.create({
  sectionActions: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingBlockStart: '0.875rem',
    paddingBlockEnd: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  skeletonList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    paddingBlock: '0.875rem',
  },
  dangerAction: {
    color: tokens['--xid-danger'],
    fontSize: '0.8125rem',
    transitionProperty: 'color',
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
  },
  smallAction: {
    fontSize: '0.8125rem',
  },
  renameForm: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'flex-end',
    maxWidth: '28rem',
  },
  itemMeta: {
    margin: 0,
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  itemError: {
    margin: '0.25rem 0 0',
    fontSize: '0.8125rem',
    color: tokens['--xid-danger'],
  },
  actionGroup: {
    display: 'flex',
    gap: '0.375rem',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  passkeyList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
})

type PasskeyItemProps = {
  passkey: PasskeyCredential
  renameMutate: (vars: { id: string; deviceName: string }) => Promise<unknown>
  removeMutate: (id: string) => Promise<unknown>
}

function PasskeyItem({ passkey, renameMutate, removeMutate }: PasskeyItemProps): ReactNode {
  const { t } = useLingui()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(passkey.deviceName ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const securityError = useSecurityActionError()

  const handleRename = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setIsSaving(true)
    try {
      await renameMutate({ id: passkey.id, deviceName: editName.trim() })
      setIsEditing(false)
      setError(null)
    } catch (err) {
      setError(securityError(err, t`Failed to rename passkey.`))
    } finally {
      setIsSaving(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    setIsRemoving(true)
    try {
      await removeMutate(passkey.id)
      setShowConfirm(false)
    } catch (err) {
      setError(securityError(err, t`Failed to remove passkey.`))
      setShowConfirm(false)
    } finally {
      setIsRemoving(false)
    }
  }

  const displayName = passkey.deviceName ?? t`Unnamed passkey`
  const lastUsed = passkey.lastUsedAt ? new Date(passkey.lastUsedAt).toLocaleDateString() : t`Never`

  if (isEditing) {
    return (
      <li>
        <SectionRow variant="control" label={<Trans>Device name</Trans>}>
          <form onSubmit={(e) => void handleRename(e)} {...stylex.props(styles.renameForm)}>
            <Field error={error ?? undefined}>
              <Input
                aria-label={t`Device name`}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
                maxLength={64}
              />
            </Field>
            <Button type="submit" variant="primary" isLoading={isSaving}>
              <Trans>Save</Trans>
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setIsEditing(false)
                setError(null)
              }}
              disabled={isSaving}
            >
              <Trans>Cancel</Trans>
            </Button>
          </form>
        </SectionRow>
      </li>
    )
  }

  return (
    <li>
      <SectionRow
        variant="split"
        label={<span {...stylex.props(styles.itemMeta)}>{displayName}</span>}
        action={
          <div {...stylex.props(styles.actionGroup)}>
            <Button
              variant="ghost"
              onClick={() => {
                setIsEditing(true)
                setEditName(passkey.deviceName ?? '')
              }}
              aria-label={t`Rename ${displayName}`}
              {...stylex.props(styles.smallAction)}
            >
              <Trans>Rename</Trans>
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowConfirm(true)}
              aria-label={t`Remove ${displayName}`}
              {...stylex.props(styles.dangerAction)}
            >
              <Trans>Remove</Trans>
            </Button>
          </div>
        }
      >
        <p {...stylex.props(styles.itemMeta)}>
          <Trans>Last used: {lastUsed}</Trans>
        </p>
        {error ? <p {...stylex.props(styles.itemError)}>{error}</p> : null}
      </SectionRow>

      {showConfirm ? (
        <ConfirmDialog
          title={<Trans>Remove passkey?</Trans>}
          description={
            <Trans>
              "{displayName}" will be permanently removed. You will need to re-register it to use
              passkey sign-in on this device.
            </Trans>
          }
          confirmLabel={<Trans>Remove</Trans>}
          isLoading={isRemoving}
          onConfirm={() => void handleRemove()}
          onCancel={() => setShowConfirm(false)}
        />
      ) : null}
    </li>
  )
}

function PasskeyEmptyState(): ReactNode {
  return (
    <EmptyState
      title={<Trans>No passkeys registered</Trans>}
      description={<Trans>Sign in with a passkey for a faster, more secure experience.</Trans>}
    />
  )
}

export type PasskeySectionProps = {
  onRegistered?: () => void | Promise<void>
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

export function PasskeySection({ onRegistered }: PasskeySectionProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const { data: passkeys, isPending, error } = usePasskeysQuery()
  const authConfig = useQuery(authConfigQueryOptions({}, api))
  const registerPasskey = useRegisterPasskey()
  const renamePasskey = useRenamePasskey()
  const removePasskey = useRemovePasskey()
  const securityError = useSecurityActionError()
  const defaultDeviceName = useDefaultPasskeyName()
  const reregistration = usePasskeyReregistrationNotice(
    authConfig.data?.passkeyEntry.reregistrationRequired ?? false,
  )
  const [registerError, setRegisterError] = useState<string | null>(null)

  const handleRegister = async (): Promise<void> => {
    setRegisterError(null)
    try {
      await registerPasskey.mutateAsync({ deviceName: defaultDeviceName })
      trackPasskeyRegistered()
    } catch (err) {
      const fallback = t`Failed to add passkey.`
      const browserMessage = registrationErrorMessage(err, {
        duplicate: t`This device already has a passkey for your account.`,
        fallback,
      })
      setRegisterError(browserMessage === undefined ? securityError(err, fallback) : browserMessage)
      return
    }
    reregistration.dismiss()
    await onRegistered?.()
  }

  return (
    <Section label={<Trans>Passkeys</Trans>}>
      {reregistration.visible ? (
        <Alert tone="info">
          <Trans>
            Passkeys created on a different address do not work here. Add a passkey for this address
            to keep signing in with a passkey.
          </Trans>{' '}
          <Button
            variant="ghost"
            onClick={reregistration.dismiss}
            {...stylex.props(styles.smallAction)}
          >
            <Trans>Dismiss</Trans>
          </Button>
        </Alert>
      ) : null}
      <div {...stylex.props(styles.sectionActions)}>
        <Button
          variant="secondary"
          onClick={() => void handleRegister()}
          isLoading={registerPasskey.isPending}
        >
          <Trans>Add passkey</Trans>
        </Button>
      </div>

      {registerError ? <Alert tone="error">{registerError}</Alert> : null}

      {isPending ? (
        <div {...stylex.props(styles.skeletonList)}>
          <Skeleton height="2.75rem" />
          <Skeleton height="2.75rem" />
          <Skeleton height="2.75rem" />
        </div>
      ) : error ? (
        <Alert tone="error">
          {error.longMessage || error.message || t`Failed to load passkeys.`}
        </Alert>
      ) : !passkeys || passkeys.length === 0 ? (
        <PasskeyEmptyState />
      ) : (
        <ul role="list" {...stylex.props(styles.passkeyList)}>
          {passkeys.map((pk) => (
            <PasskeyItem
              key={pk.id}
              passkey={pk}
              renameMutate={renamePasskey.mutateAsync}
              removeMutate={removePasskey.mutateAsync}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}
