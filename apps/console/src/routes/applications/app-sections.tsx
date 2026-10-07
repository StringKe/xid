// 应用详情的各个设置区块:每块各自保存,保存按钮不禁用,错误留在本块。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import {
  Alert,
  Button,
  CheckboxField,
  CopyField,
  Field,
  Input,
  Select,
  useToast,
} from '@xid-kit/web-ui/ui'
import { detail } from '../../components/page/detail-styles'
import type { AppRecord, UpdateAppInput } from './app-api'
import { appKind, useUpdateApplication } from './app-api'
import { usesSharedSecret } from './app-format'
import { sections as styles } from './section-styles'

export function SectionShell({
  id,
  title,
  lead,
  children,
}: {
  id: string
  title: ReactNode
  lead?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section id={id} {...stylex.props(styles.section)}>
      <div {...stylex.props(detail.sectionText)}>
        <h2 {...stylex.props(detail.sectionTitle)}>{title}</h2>
        {lead ? <p {...stylex.props(detail.sectionLead)}>{lead}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function useSave(app: AppRecord, success: string) {
  const { notify } = useToast()
  const update = useUpdateApplication(app.id)
  return {
    update,
    save: (body: UpdateAppInput) =>
      update.mutate(body, { onSuccess: () => notify({ title: success }) }),
  }
}

const DETAIL_FIELDS = ['name', 'logo_uri', 'project_id'] as const

export function DetailsSection({
  app,
  projects,
}: {
  app: AppRecord
  projects: readonly { id: string; name: string }[]
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { update, save } = useSave(app, t`Details saved`)
  const [name, setName] = useState(app.name)
  const [logo, setLogo] = useState(app.logo_uri ?? '')
  const [projectId, setProjectId] = useState(app.project_id ?? '')
  const [firstParty, setFirstParty] = useState(app.first_party)
  const fieldError = (field: string) =>
    errorTargetsField(update.error, field) ? errorMessage(update.error) : undefined
  const machine = appKind(app) === 'machine'

  function submit(event: FormEvent): void {
    event.preventDefault()
    save({
      name: name.trim(),
      logo_uri: logo.trim() || null,
      ...(projectId !== (app.project_id ?? '') ? { project_id: projectId || null } : {}),
      first_party: firstParty,
    })
  }

  return (
    <SectionShell id="details" title={<Trans>Details</Trans>}>
      <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
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
        <Field
          label={<Trans>Logo URL</Trans>}
          hint={<Trans>A public HTTPS image.</Trans>}
          error={fieldError('logo_uri')}
        >
          <Input
            value={logo}
            onChange={(event) => setLogo(event.currentTarget.value)}
            spellCheck={false}
          />
        </Field>
        <Field label={<Trans>Project</Trans>} error={fieldError('project_id')}>
          <Select value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
            <option value="">{t`No project`}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        {machine ? null : (
          <CheckboxField
            checked={firstParty}
            onCheckedChange={setFirstParty}
            label={<Trans>First-party app: skip the consent screen</Trans>}
            description={
              <Trans>
                Only for apps you own. Third-party apps always ask users to approve access.
              </Trans>
            }
          />
        )}
        {update.error && !DETAIL_FIELDS.some((field) => errorTargetsField(update.error, field)) ? (
          <Alert tone="error">{errorMessage(update.error)}</Alert>
        ) : null}
        <div>
          <Button type="submit" isLoading={update.isPending}>
            <Trans>Save details</Trans>
          </Button>
        </div>
      </form>
    </SectionShell>
  )
}

function AuthMethodText({ method }: { method: string }): ReactNode {
  switch (method) {
    case 'client_secret_basic':
      return <Trans>Client secret in the Authorization header (client_secret_basic)</Trans>
    case 'client_secret_post':
      return <Trans>Client secret in the request body (client_secret_post)</Trans>
    case 'private_key_jwt':
      return <Trans>Signed JWT with a registered key (private_key_jwt)</Trans>
    case 'tls_client_auth':
      return <Trans>Mutual TLS with a CA-issued certificate (tls_client_auth)</Trans>
    case 'self_signed_tls_client_auth':
      return <Trans>Mutual TLS with a pinned certificate (self_signed_tls_client_auth)</Trans>
    case 'none':
      return <Trans>No client authentication; PKCE protects the code exchange</Trans>
    default:
      return method
  }
}

export function CredentialsSection({
  app,
  onRotate,
}: {
  app: AppRecord
  onRotate: () => void
}): ReactNode {
  const { t } = useLingui()
  const name = app.name
  const sharedSecret = usesSharedSecret(app)
  return (
    <SectionShell
      id="credentials"
      title={<Trans>Credentials</Trans>}
      lead={
        sharedSecret ? (
          <Trans>
            {name} proves who it is with a client secret when it exchanges a code for tokens.
          </Trans>
        ) : app.client_type === 'public' ? (
          <Trans>
            {name} runs where a secret cannot be kept, so every sign-in uses PKCE (S256).
          </Trans>
        ) : (
          <Trans>{name} authenticates without a shared secret.</Trans>
        )
      }
    >
      <Field label={<Trans>Client ID</Trans>}>
        <CopyField value={app.client_id} subject={t`client ID`} />
      </Field>
      <div {...stylex.props(styles.readonly)}>
        <span {...stylex.props(detail.attrLabel)}>
          <Trans>How the app authenticates</Trans>
        </span>
        <span>
          <AuthMethodText method={app.token_endpoint_auth_method} />
        </span>
      </div>
      {sharedSecret ? (
        <div {...stylex.props(styles.secretBox)}>
          <div {...stylex.props(detail.itemMain)}>
            <span {...stylex.props(detail.itemTitle)}>
              <Trans>Client secret is set</Trans>
            </span>
            <span {...stylex.props(detail.itemSub)}>
              <Trans>
                One secret is active at a time. XID keeps only a hash, so the secret cannot be shown
                again; rotating creates a new one and shows it once.
              </Trans>
            </span>
          </div>
          <Button variant="secondary" onClick={onRotate}>
            <Trans>Rotate secret…</Trans>
          </Button>
        </div>
      ) : null}
    </SectionShell>
  )
}
