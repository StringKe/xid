// 创建顶层组织:名称、slug(跟随名称生成,手动改过后不再覆盖)和 owner 邮箱。
// 服务端创建组织并给 owner 发邀请;slug 在实例内已占用时把错误落到 slug 字段。
// 调用方每次打开都重新挂载,表单状态不跨次保留。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Alert, Button, Dialog, Field, Input } from '@xid-kit/web-ui/ui'
import { useCreatePlatformOrganization } from './orgs-users-queries'
import type { PlatformOrganizationListItem } from './orgs-users-queries'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

const styles = stylex.create({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
})

function slugFrom(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

export function CreateOrganizationDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (organization: PlatformOrganizationListItem) => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const create = useCreatePlatformOrganization()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [ownerEmail, setOwnerEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const slugTaken = create.error?.code === 'conflict'
  const nameError = submitted && name.trim() === '' ? t`Enter the organization name.` : undefined
  const slugError = slugTaken
    ? t`This slug is already used on this instance.`
    : submitted && !SLUG_PATTERN.test(slug)
      ? t`Use lowercase letters, numbers and hyphens, starting with a letter or number.`
      : undefined
  const emailError =
    create.error?.meta?.paramName === 'ownerEmail' || (submitted && !ownerEmail.includes('@'))
      ? t`Enter the owner's full email address.`
      : undefined
  const generalError =
    create.error && !slugTaken && create.error.meta?.paramName === undefined
      ? errorMessage(create.error, { surface: 'general' })
      : undefined

  function submit(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault()
    setSubmitted(true)
    if (!name.trim() || !SLUG_PATTERN.test(slug) || !ownerEmail.includes('@')) return
    create.mutate(
      { name: name.trim(), slug, ownerEmail: ownerEmail.trim() },
      { onSuccess: onCreated },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Create organization</Trans>}
      description={
        <Trans>
          The organization gets its own users, sign-in settings and audit log. The owner receives an
          email invitation and becomes the first organization admin after accepting it.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
      dismissible={!create.isPending}
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button isLoading={create.isPending} onClick={() => submit()}>
            <Trans>Create organization</Trans>
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field label={<Trans>Name</Trans>} required error={nameError}>
          <Input
            value={name}
            autoComplete="organization"
            onChange={(event) => {
              const next = event.currentTarget.value
              setName(next)
              if (!slugEdited) setSlug(slugFrom(next))
            }}
          />
        </Field>
        <Field
          label={<Trans>Slug</Trans>}
          required
          error={slugError}
          hint={<Trans>Used in the organization's sign-in address.</Trans>}
        >
          <Input
            value={slug}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setSlug(event.currentTarget.value.toLowerCase())
              setSlugEdited(true)
              if (slugTaken) create.reset()
            }}
          />
        </Field>
        <Field label={<Trans>Owner email</Trans>} required error={emailError}>
          <Input
            type="email"
            value={ownerEmail}
            autoComplete="off"
            onChange={(event) => setOwnerEmail(event.currentTarget.value)}
          />
        </Field>
        {generalError ? <Alert tone="error">{generalError}</Alert> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
