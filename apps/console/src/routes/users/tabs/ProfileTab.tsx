// Profile:姓名、用户名、语言、时区、来源与公开 metadata;「Edit profile…」编辑可写字段。

import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@xid-kit/web-ui/locale'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import {
  Alert,
  Button,
  CodeBlock,
  Dialog,
  Field,
  Input,
  Select,
  useToast,
} from '@xid-kit/web-ui/ui'
import { detail } from '../../../components/page/detail-styles'
import type { UserDetail, UserSource } from '../user-api'
import { useUpdateUser } from '../user-api'

const SOURCE_LABELS: Record<UserSource, MessageDescriptor> = {
  directory_sync: msg`directory sync`,
  sso: msg`enterprise SSO sign-in`,
  self_signup: msg`self sign-up`,
  guest: msg`a guest session`,
  admin: msg`an admin or the Management API`,
}

export function useSourceLabel(source: UserSource): string {
  const { i18n } = useLingui()
  return i18n._(SOURCE_LABELS[source])
}

function localeLabel(value: string | null): string | null {
  if (!value) return null
  return (LOCALE_LABELS as Record<string, string>)[value] ?? value
}

function EditProfileDialog({
  user,
  onClose,
}: {
  user: UserDetail
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateUser(user.id)
  const [firstName, setFirstName] = useState(user.firstName ?? '')
  const [lastName, setLastName] = useState(user.lastName ?? '')
  const [username, setUsername] = useState(user.username ?? '')
  const [locale, setLocale] = useState(user.locale ?? '')
  const [timezone, setTimezone] = useState(user.timezone ?? '')
  const error = update.error
  const fieldError = (field: string) =>
    errorTargetsField(error, field) ? errorMessage(error) : undefined

  function submit(event: FormEvent): void {
    event.preventDefault()
    update.mutate(
      {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(locale ? { locale } : {}),
        ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
      },
      {
        onSuccess: () => {
          notify({ title: t`Profile saved` })
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || update.isPending ? undefined : onClose())}
      title={<Trans>Edit profile</Trans>}
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
      footer={
        <>
          <Button variant="secondary" disabled={update.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form="edit-profile-form" isLoading={update.isPending}>
            <Trans>Save profile</Trans>
          </Button>
        </>
      }
    >
      <form id="edit-profile-form" onSubmit={submit} noValidate {...stylex.props(detail.section)}>
        <Field label={<Trans>First name</Trans>} error={fieldError('first_name')}>
          <Input value={firstName} onChange={(e) => setFirstName(e.currentTarget.value)} />
        </Field>
        <Field label={<Trans>Last name</Trans>} error={fieldError('last_name')}>
          <Input value={lastName} onChange={(e) => setLastName(e.currentTarget.value)} />
        </Field>
        <Field label={<Trans>Username</Trans>} error={fieldError('username')}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            spellCheck={false}
          />
        </Field>
        <Field label={<Trans>Language</Trans>} error={fieldError('locale')}>
          <Select value={locale} onChange={(e) => setLocale(e.currentTarget.value)}>
            <option value="">{t`Not set`}</option>
            {SUPPORTED_LOCALES.map((code) => (
              <option key={code} value={code}>
                {LOCALE_LABELS[code]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={<Trans>Time zone</Trans>}
          hint={<Trans>An IANA name, for example Asia/Kolkata.</Trans>}
          error={fieldError('timezone')}
        >
          <Input
            value={timezone}
            onChange={(e) => setTimezone(e.currentTarget.value)}
            spellCheck={false}
          />
        </Field>
        {error &&
        !['first_name', 'last_name', 'username', 'locale', 'timezone'].some((f) =>
          errorTargetsField(error, f),
        ) ? (
          <Alert tone="error">{errorMessage(error)}</Alert>
        ) : null}
      </form>
    </Dialog>
  )
}

export function ProfileTab({ user, name }: { user: UserDetail; name: string }): ReactNode {
  const { t } = useLingui()
  const [editing, setEditing] = useState(false)
  const source = useSourceLabel(user.source)
  const notSet = <span {...stylex.props(detail.muted)}>{t`Not set`}</span>
  const rows: { key: string; label: string; value: ReactNode }[] = [
    { key: 'first', label: t`First name`, value: user.firstName ?? notSet },
    { key: 'last', label: t`Last name`, value: user.lastName ?? notSet },
    { key: 'username', label: t`Username`, value: user.username ?? notSet },
    { key: 'locale', label: t`Language`, value: localeLabel(user.locale) ?? notSet },
    { key: 'timezone', label: t`Time zone`, value: user.timezone ?? notSet },
    { key: 'source', label: t`Source`, value: <Trans>Created by {source}</Trans> },
  ]
  const hasMetadata = Object.keys(user.publicMetadata ?? {}).length > 0
  return (
    <>
      <section {...stylex.props(detail.section)}>
        <div {...stylex.props(detail.sectionHead)}>
          <div {...stylex.props(detail.sectionText)}>
            <h2 {...stylex.props(detail.sectionTitle)}>
              <Trans>Profile</Trans>
            </h2>
          </div>
          {user.status === 'deleted' ? null : (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Trans>Edit profile…</Trans>
            </Button>
          )}
        </div>
        <dl {...stylex.props(detail.rows)}>
          {rows.map((row) => (
            <div key={row.key} {...stylex.props(detail.row)}>
              <dt {...stylex.props(detail.rowLabel)}>{row.label}</dt>
              <dd {...stylex.props(detail.rowValue)}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section {...stylex.props(detail.section)}>
        <div {...stylex.props(detail.sectionText)}>
          <h2 {...stylex.props(detail.sectionTitle)}>
            <Trans>Public metadata</Trans>
          </h2>
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>Key-value data about {name}, set and read through the Management API.</Trans>
          </p>
        </div>
        {hasMetadata ? (
          <CodeBlock
            code={JSON.stringify(user.publicMetadata, null, 2)}
            language="json"
            subject={t`public metadata`}
          />
        ) : (
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>No public metadata.</Trans>
          </p>
        )}
      </section>
      {editing ? <EditProfileDialog user={user} onClose={() => setEditing(false)} /> : null}
    </>
  )
}
