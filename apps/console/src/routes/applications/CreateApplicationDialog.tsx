// 创建应用:先选类型(决定客户端类型、授权方式与 grant),再填名称、所属项目与回调地址。
// 共享 secret 的应用创建后立刻一次性展示 secret。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import {
  Alert,
  Button,
  Dialog,
  Field,
  Input,
  RadioGroup,
  Select,
  Textarea,
} from '@xid-kit/web-ui/ui'
import type { AppKind, CreateAppInput, CreatedApp } from './app-api'
import { useCreateApplication } from './app-api'
import { KIND_LABELS } from './app-format'

const KINDS: readonly Exclude<AppKind, 'device'>[] = ['web', 'spa', 'native', 'machine']

function inputFor(
  kind: Exclude<AppKind, 'device'>,
): Omit<CreateAppInput, 'name' | 'redirect_uris'> {
  switch (kind) {
    case 'web':
      return { client_type: 'confidential', application_type: 'web' }
    case 'spa':
      return { client_type: 'public', application_type: 'web' }
    case 'native':
      return { client_type: 'public', application_type: 'native' }
    case 'machine':
      return {
        client_type: 'confidential',
        token_endpoint_auth_method: 'client_secret_basic',
        allowed_grant_types: ['client_credentials'],
      }
  }
}

const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
})

export function CreateApplicationDialog({
  projects,
  defaultProjectId,
  requireProject,
  onClose,
  onCreated,
}: {
  projects: readonly { id: string; name: string }[]
  defaultProjectId?: string
  requireProject: boolean
  onClose: () => void
  onCreated: (app: CreatedApp) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateApplication()
  const [kind, setKind] = useState<Exclude<AppKind, 'device'>>('web')
  const [name, setName] = useState('')
  const [projectId, setProjectId] = useState(
    defaultProjectId ?? (requireProject ? (projects[0]?.id ?? '') : ''),
  )
  const [redirects, setRedirects] = useState('')
  const error = create.error
  const fieldError = (field: string) =>
    errorTargetsField(error, field) ? errorMessage(error) : undefined
  const descriptions: Record<Exclude<AppKind, 'device'>, ReactNode> = {
    web: <Trans>Runs on your servers and keeps a client secret.</Trans>,
    spa: <Trans>Runs in the browser. Uses PKCE, no secret.</Trans>,
    native: <Trans>Mobile or desktop app. Uses PKCE and may use custom-scheme redirects.</Trans>,
    machine: <Trans>Calls APIs as itself with client credentials. No user sign-in.</Trans>,
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    create.mutate(
      {
        name: name.trim(),
        ...inputFor(kind),
        ...(projectId ? { project_id: projectId } : {}),
        redirect_uris:
          kind === 'machine'
            ? []
            : redirects
                .split(/\s+/)
                .map((uri) => uri.trim())
                .filter(Boolean),
      },
      { onSuccess: onCreated },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || create.isPending ? undefined : onClose())}
      title={<Trans>Create application</Trans>}
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="lg"
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            form="create-app-form"
            disabled={!name.trim() || (requireProject && !projectId)}
            isLoading={create.isPending}
          >
            <Trans>Create application</Trans>
          </Button>
        </>
      }
    >
      <form id="create-app-form" onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <RadioGroup
          label={<Trans>Application type</Trans>}
          value={kind}
          onValueChange={(value) => setKind(value as Exclude<AppKind, 'device'>)}
          options={KINDS.map((option) => ({
            value: option,
            label: i18n._(KIND_LABELS[option]),
            description: descriptions[option],
          }))}
        />
        <Field
          label={<Trans>Name</Trans>}
          hint={<Trans>Shown to users on the consent screen.</Trans>}
          error={fieldError('name')}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={200}
          />
        </Field>
        <Field label={<Trans>Project</Trans>} error={fieldError('project_id')}>
          <Select value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
            {requireProject ? null : <option value="">{t`No project`}</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        {kind === 'machine' ? null : (
          <Field
            label={<Trans>Redirect URIs</Trans>}
            hint={<Trans>One per line. Each must match exactly; wildcards are not allowed.</Trans>}
            error={fieldError('redirect_uris')}
          >
            <Textarea
              rows={3}
              value={redirects}
              onChange={(event) => setRedirects(event.currentTarget.value)}
              spellCheck={false}
            />
          </Field>
        )}
        {error &&
        !['name', 'project_id', 'redirect_uris'].some((field) =>
          errorTargetsField(error, field),
        ) ? (
          <Alert tone="error">{errorMessage(error)}</Alert>
        ) : null}
      </form>
    </Dialog>
  )
}
