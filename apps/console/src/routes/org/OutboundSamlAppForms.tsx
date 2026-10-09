// SAML app 的新建 / 编辑对话框、「谁能登录」表单和显示名换算。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { OUTBOUND_CONSOLE_PRESETS } from '@xid-kit/protocol'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Dialog, Field, Input, Select, Textarea } from '@xid-kit/web-ui/ui'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useCreateOutboundSamlApp, useUpdateOutboundSamlApp } from './queries'
import type { XidError } from '@xid-kit/types'
import type { AssignmentGate, CreateOutboundSamlAppInput, OutboundSamlApp } from './types'
import { ChoiceCards, SaveStatus } from './AuthSettingsControls'

const styles = stylex.create({
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    minWidth: 0,
  },
  error: {
    margin: 0,
    color: tokens['--xid-danger'],
    fontSize: text.sm,
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    width: '100%',
  },
})

export function presetForKey(key: string) {
  return OUTBOUND_CONSOLE_PRESETS.find((item) => item.key === key)
}

function hostOf(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

export function appDisplayName(app: Pick<OutboundSamlApp, 'provider' | 'spEntityId'>): string {
  return presetForKey(app.provider)?.label ?? hostOf(app.spEntityId)
}

function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function parseCertificates(value: string): string[] {
  const pemPattern = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/gu
  const pemCertificates = [...value.matchAll(pemPattern)]
    .map((match) => (match[1] ?? '').replace(/\s+/gu, ''))
    .filter(Boolean)
  const base64Certificates = value
    .replace(pemPattern, '\n\n')
    .trim()
    .split(/\n\s*\n/gu)
    .map((block) => block.replace(/\s+/gu, ''))
    .filter(Boolean)
  return [...new Set([...pemCertificates, ...base64Certificates])]
}

type MetadataSource = 'none' | 'url' | 'xml'

type AppForm = {
  preset: string
  metadataSource: MetadataSource
  metadataUrl: string
  metadataXml: string
  spEntityId: string
  acsUrl: string
  sloUrl: string
  sloBinding: 'redirect' | 'post'
  spCertificates: string
}

const EMPTY_FORM: AppForm = {
  preset: '',
  metadataSource: 'none',
  metadataUrl: '',
  metadataXml: '',
  spEntityId: '',
  acsUrl: '',
  sloUrl: '',
  sloBinding: 'redirect',
  spCertificates: '',
}

const FIELD_PARAMS = {
  metadata: ['sp_metadata_url', 'sp_metadata_xml'],
  spEntityId: ['sp_entity_id'],
  acsUrl: ['acs_url'],
  sloUrl: ['slo_url'],
  spCertificates: ['sp_certificates'],
} as const

type FieldKey = keyof typeof FIELD_PARAMS

function formOf(app: OutboundSamlApp | null): AppForm {
  if (!app) return EMPTY_FORM
  return {
    ...EMPTY_FORM,
    preset: app.provider,
    spEntityId: app.spEntityId,
    acsUrl: app.acsUrl,
    sloUrl: app.sloUrl ?? '',
    sloBinding: app.sloBinding,
    spCertificates: app.spCertificates.join('\n\n'),
  }
}

function isImporting(form: AppForm): boolean {
  if (form.metadataSource === 'url') return form.metadataUrl.trim().length > 0
  if (form.metadataSource === 'xml') return form.metadataXml.trim().length > 0
  return false
}

function toPayload(form: AppForm): CreateOutboundSamlAppInput {
  const certificates = parseCertificates(form.spCertificates)
  const base = {
    preset: form.preset || undefined,
    sp_entity_id: form.spEntityId.trim() || undefined,
    slo_binding: form.sloBinding,
  }
  if (!isImporting(form)) {
    return {
      ...base,
      acs_url: form.acsUrl,
      slo_url: form.sloUrl.trim() || null,
      sp_certificates: certificates,
    }
  }
  return {
    ...base,
    acs_url: form.acsUrl.trim() || undefined,
    slo_url: form.sloUrl.trim() || undefined,
    sp_certificates: certificates.length > 0 ? certificates : undefined,
    ...(form.metadataSource === 'url'
      ? { sp_metadata_url: form.metadataUrl.trim() }
      : { sp_metadata_xml: form.metadataXml }),
  }
}

function fieldWithError(error: XidError | null): FieldKey | null {
  const param = error?.meta?.paramName
  if (!param) return null
  const entry = Object.entries(FIELD_PARAMS).find(([, params]) =>
    (params as readonly string[]).includes(param),
  )
  return entry ? (entry[0] as FieldKey) : null
}

export function OutboundAppDialog({
  orgId,
  app,
  onClose,
  onCreated,
}: {
  orgId: string
  app: OutboundSamlApp | null
  onClose: () => void
  onCreated?: (app: OutboundSamlApp) => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const create = useCreateOutboundSamlApp(orgId)
  const update = useUpdateOutboundSamlApp(orgId)
  const [form, setForm] = useState<AppForm>(() => formOf(app))
  const [formError, setFormError] = useState<string | null>(null)
  const [imported, setImported] = useState(false)
  const mutationError = create.error ?? update.error
  const errorField = fieldWithError(mutationError)
  const isPending = create.isPending || update.isPending
  const appName = app ? appDisplayName(app) : ''
  const importing = isImporting(form)

  function patch(next: Partial<AppForm>): void {
    setImported(false)
    setForm((prev) => ({ ...prev, ...next }))
  }

  function applyPreset(key: string): void {
    const preset = presetForKey(key)
    setForm(
      preset
        ? { ...EMPTY_FORM, preset: key, spEntityId: preset.entityId, acsUrl: preset.acsUrl }
        : { ...form, preset: '' },
    )
  }

  function fieldError(key: FieldKey): string | undefined {
    return errorField === key && mutationError ? errorMessage(mutationError) : undefined
  }

  function validate(): string | null {
    if (form.metadataSource !== 'none' && !importing) {
      return form.metadataSource === 'url'
        ? t`Enter the metadata URL, or choose to enter the details yourself.`
        : t`Paste the metadata XML, or choose to enter the details yourself.`
    }
    if (!importing && !form.acsUrl.trim()) return t`ACS URL is required.`
    if (!importing && form.sloUrl.trim() && parseCertificates(form.spCertificates).length === 0) {
      return t`SP signing certificate is required when an SLO URL is configured.`
    }
    return null
  }

  function submit(): void {
    const problem = validate()
    setFormError(problem)
    if (problem) return
    const payload = toPayload(form)
    if (app) {
      update.mutate(
        { appId: app.id, payload },
        {
          onSuccess: (saved) => {
            if (!importing) {
              onClose()
              return
            }
            setForm(formOf(saved))
            setImported(true)
          },
        },
      )
      return
    }
    create.mutate(
      { ...payload, assignment_gate: { mode: 'all', allowed_roles: [], allowed_user_ids: [] } },
      { onSuccess: (created) => onCreated?.(created) },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={app ? <Trans>Edit {appName}</Trans> : <Trans>Add SAML app</Trans>}
      position={{ narrow: 'fullscreen', regular: 'side' }}
      size="md"
      footer={
        <div {...stylex.props(styles.footer)}>
          <Button type="button" variant="secondary" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form="saml-app-form" isLoading={isPending}>
            {app ? <Trans>Save app</Trans> : <Trans>Add app</Trans>}
          </Button>
        </div>
      }
    >
      <form
        id="saml-app-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        {...stylex.props(styles.form)}
      >
        {app ? null : (
          <Field label={<Trans>App</Trans>}>
            <Select value={form.preset} onChange={(event) => applyPreset(event.target.value)}>
              <option value="">{t`Another SAML app`}</option>
              {OUTBOUND_CONSOLE_PRESETS.map((preset) => (
                <option key={preset.key} value={preset.key}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label={<Trans>App metadata</Trans>}
          hint={
            <Trans>
              Import the app&apos;s SAML metadata to fill in the fields below. Fields you fill in
              yourself take precedence.
            </Trans>
          }
        >
          <Select
            value={form.metadataSource}
            onChange={(event) => patch({ metadataSource: event.target.value as MetadataSource })}
          >
            <option value="none">{t`Enter the details yourself`}</option>
            <option value="url">{t`Import from a metadata URL`}</option>
            <option value="xml">{t`Paste metadata XML`}</option>
          </Select>
        </Field>
        {form.metadataSource === 'url' ? (
          <Field label={<Trans>Metadata URL</Trans>} error={fieldError('metadata')}>
            <Input
              type="url"
              value={form.metadataUrl}
              spellCheck={false}
              placeholder="https://"
              onChange={(event) => patch({ metadataUrl: event.target.value })}
            />
          </Field>
        ) : null}
        {form.metadataSource === 'xml' ? (
          <Field label={<Trans>Metadata XML</Trans>} error={fieldError('metadata')}>
            <Textarea
              rows={6}
              spellCheck={false}
              value={form.metadataXml}
              onChange={(event) => patch({ metadataXml: event.target.value })}
            />
          </Field>
        ) : null}
        {imported ? (
          <p role="status" {...stylex.props(styles.note)}>
            <Trans>Imported. The fields below now show the saved values.</Trans>
          </p>
        ) : null}
        <Field
          label={<Trans>Entity ID</Trans>}
          hint={<Trans>Replace any part in braces with the value from the app.</Trans>}
          error={fieldError('spEntityId')}
        >
          <Input
            value={form.spEntityId}
            spellCheck={false}
            onChange={(event) => patch({ spEntityId: event.target.value })}
          />
        </Field>
        <Field label={<Trans>Assertion consumer URL</Trans>} error={fieldError('acsUrl')}>
          <Input
            value={form.acsUrl}
            spellCheck={false}
            onChange={(event) => patch({ acsUrl: event.target.value })}
          />
        </Field>
        <Field
          label={<Trans>Single logout URL</Trans>}
          hint={<Trans>Optional. Needs the app&apos;s signing certificate below.</Trans>}
          error={fieldError('sloUrl')}
        >
          <Input
            value={form.sloUrl}
            spellCheck={false}
            onChange={(event) => patch({ sloUrl: event.target.value })}
          />
        </Field>
        <Field label={<Trans>Logout binding</Trans>}>
          <Select
            value={form.sloBinding}
            onChange={(event) => patch({ sloBinding: event.target.value as AppForm['sloBinding'] })}
          >
            <option value="redirect">{t`HTTP-Redirect`}</option>
            <option value="post">{t`HTTP-POST`}</option>
          </Select>
        </Field>
        <Field
          label={<Trans>App signing certificates</Trans>}
          hint={<Trans>Paste PEM blocks, or separate base64 certificates with a blank line.</Trans>}
          error={fieldError('spCertificates')}
        >
          <Textarea
            rows={5}
            spellCheck={false}
            value={form.spCertificates}
            onChange={(event) => patch({ spCertificates: event.target.value })}
          />
        </Field>
        {formError || (mutationError && errorField === null) ? (
          <p role="alert" {...stylex.props(styles.error)}>
            {formError ?? (mutationError ? errorMessage(mutationError) : null)}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}

export function WhoCanSignInForm({
  orgId,
  app,
  locked,
}: {
  orgId: string
  app: OutboundSamlApp
  locked: boolean
}): ReactNode {
  const { t } = useLingui()
  const update = useUpdateOutboundSamlApp(orgId)
  const [mode, setMode] = useState<AssignmentGate['mode']>(app.assignmentGate.mode)
  const [roles, setRoles] = useState(app.assignmentGate.allowed_roles.join(', '))
  const [users, setUsers] = useState(app.assignmentGate.allowed_user_ids.join(', '))
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setMode(app.assignmentGate.mode)
    setRoles(app.assignmentGate.allowed_roles.join(', '))
    setUsers(app.assignmentGate.allowed_user_ids.join(', '))
  }, [app.assignmentGate])

  function submit(): void {
    setSaved(false)
    const gate: AssignmentGate =
      mode === 'all'
        ? { mode: 'all', allowed_roles: [], allowed_user_ids: [] }
        : {
            mode: 'restricted',
            allowed_roles: parseCommaSeparated(roles),
            allowed_user_ids: parseCommaSeparated(users),
          }
    update.mutate(
      { appId: app.id, payload: { assignment_gate: gate } },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <fieldset disabled={locked} {...stylex.props(styles.form)}>
        <ChoiceCards<AssignmentGate['mode']>
          legend={t`Who can sign in`}
          value={mode}
          onChange={setMode}
          options={[
            {
              value: 'all',
              label: <Trans>All members</Trans>,
              description: <Trans>Every active member of this organization.</Trans>,
            },
            {
              value: 'restricted',
              label: <Trans>Only some members</Trans>,
              description: (
                <Trans>
                  Members with the roles or user IDs below. Outbound provisioning follows the same
                  list.
                </Trans>
              ),
            },
          ]}
        />
        {mode === 'restricted' ? (
          <>
            <Field label={<Trans>Roles</Trans>} hint={<Trans>Separate roles with commas.</Trans>}>
              <Input
                value={roles}
                placeholder={t`admin, owner`}
                onChange={(event) => setRoles(event.target.value)}
              />
            </Field>
            <Field
              label={<Trans>User IDs</Trans>}
              hint={<Trans>Separate user IDs with commas.</Trans>}
            >
              <Input
                value={users}
                spellCheck={false}
                onChange={(event) => setUsers(event.target.value)}
              />
            </Field>
          </>
        ) : null}
        <div>
          <Button type="submit" isLoading={update.isPending}>
            <Trans>Save who can sign in</Trans>
          </Button>
        </div>
        <SaveStatus error={update.error} saved={saved} />
      </fieldset>
    </form>
  )
}

export function gateSummary(gate: AssignmentGate): ReactNode {
  if (gate.mode === 'all') return <Trans>All members</Trans>
  const roles = gate.allowed_roles.join(', ')
  const people = gate.allowed_user_ids.length
  const peopleLabel = <Plural value={people} one="# person" other="# people" />
  if (roles && people > 0) {
    return (
      <>
        {roles}, {peopleLabel}
      </>
    )
  }
  return roles || peopleLabel
}
