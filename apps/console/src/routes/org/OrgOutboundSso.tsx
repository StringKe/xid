import { Trans, useLingui } from '@lingui/react/macro'
import { OUTBOUND_CONSOLE_PRESETS } from '@xid-kit/protocol'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { consoleShell, page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useCreateOutboundSamlApp,
  useDeleteOutboundSamlApp,
  useOrgOutboundSamlAppsQuery,
  useUpdateOutboundSamlApp,
} from './queries'
import type { AssignmentGate, CreateOutboundSamlAppInput, OutboundSamlApp } from './types'
import { useOrgTarget } from './useOrgTarget'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  messageZone: { paddingInline: GUTTER, paddingBlock: '1.5rem' },
  tableSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  configSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '36rem',
  },
  presetRow: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  formGrid: { display: 'grid', gap: '1rem' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' },
  mono: { fontFamily: tokens['--xid-font-mono'], fontSize: '0.8125rem' },
  textarea: {
    width: '100%',
    minHeight: '6rem',
    resize: 'vertical',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    padding: '0.625rem 0.75rem',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    color: tokens['--xid-fg'],
    backgroundColor: tokens['--xid-bg'],
    boxSizing: 'border-box',
  },
})

const columns: ColumnDef<OutboundSamlApp>[] = [
  { id: 'provider', header: () => <Trans>Preset</Trans>, cell: ({ row }) => row.original.provider },
  {
    id: 'entity',
    header: () => <Trans>SP entity ID</Trans>,
    cell: ({ row }) => row.original.spEntityId,
  },
  { id: 'acs', header: () => <Trans>ACS URL</Trans>, cell: ({ row }) => row.original.acsUrl },
  {
    id: 'paths',
    header: () => <Trans>Endpoints</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.mono)}>
        {row.original.metadataPath} · {row.original.ssoPath}
      </span>
    ),
  },
]

type AppForm = {
  preset: string
  spEntityId: string
  acsUrl: string
  sloUrl: string
  sloBinding: 'redirect' | 'post'
  spCertificates: string
  oidcRedirectUri: string
}

const EMPTY_FORM: AppForm = {
  preset: '',
  spEntityId: '',
  acsUrl: '',
  sloUrl: '',
  sloBinding: 'redirect',
  spCertificates: '',
  oidcRedirectUri: '',
}

function presetForKey(key: string) {
  return OUTBOUND_CONSOLE_PRESETS.find((item) => item.key === key)
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

function buildAssignmentGate(
  mode: AssignmentGate['mode'],
  allowedRoles: string,
  allowedUserIds: string,
): AssignmentGate {
  if (mode === 'all') return { mode: 'all', allowed_user_ids: [], allowed_roles: [] }
  return {
    mode: 'restricted',
    allowed_user_ids: parseCommaSeparated(allowedUserIds),
    allowed_roles: parseCommaSeparated(allowedRoles),
  }
}

export default function OrgOutboundSso(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgOutboundSamlAppsQuery(orgId)
  const createApp = useCreateOutboundSamlApp(orgId)
  const updateApp = useUpdateOutboundSamlApp(orgId)
  const deleteApp = useDeleteOutboundSamlApp(orgId)
  const [createForm, setCreateForm] = useState<AppForm>(EMPTY_FORM)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<AppForm>(EMPTY_FORM)
  const [createGateMode, setCreateGateMode] = useState<AssignmentGate['mode']>('all')
  const [createAllowedRoles, setCreateAllowedRoles] = useState('')
  const [createAllowedUserIds, setCreateAllowedUserIds] = useState('')
  const [editGateMode, setEditGateMode] = useState<AssignmentGate['mode']>('all')
  const [editAllowedRoles, setEditAllowedRoles] = useState('')
  const [editAllowedUserIds, setEditAllowedUserIds] = useState('')
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const selected = data?.find((app) => app.id === selectedId) ?? null
  const createPreset = presetForKey(createForm.preset)

  useEffect(() => {
    if (!selected && data && data.length > 0) setSelectedId(data[0]!.id)
  }, [data, selected])

  useEffect(() => {
    if (selected) {
      const preset = presetForKey(selected.provider)
      setEditForm({
        preset: selected.provider,
        spEntityId: selected.spEntityId,
        acsUrl: selected.acsUrl,
        sloUrl: selected.sloUrl ?? '',
        sloBinding: selected.sloBinding,
        spCertificates: selected.spCertificates.join('\n\n'),
        oidcRedirectUri: preset?.oidcRedirectPlaceholder ?? '',
      })
      setEditGateMode(selected.assignmentGate.mode)
      setEditAllowedRoles(selected.assignmentGate.allowed_roles.join(', '))
      setEditAllowedUserIds(selected.assignmentGate.allowed_user_ids.join(', '))
    }
  }, [selected])

  function applyPreset(key: string): void {
    const preset = presetForKey(key)
    if (!preset) return
    setCreateForm({
      preset: preset.key,
      spEntityId: preset.entityId,
      acsUrl: preset.acsUrl,
      sloUrl: '',
      sloBinding: 'redirect',
      spCertificates: '',
      oidcRedirectUri: preset.oidcRedirectPlaceholder ?? '',
    })
  }

  function toPayload(form: AppForm): CreateOutboundSamlAppInput {
    return {
      preset: form.preset || undefined,
      sp_entity_id: form.spEntityId || undefined,
      acs_url: form.acsUrl,
      slo_url: form.sloUrl.trim() || null,
      slo_binding: form.sloBinding,
      sp_certificates: parseCertificates(form.spCertificates),
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!createForm.acsUrl.trim()) {
      setMessage({ tone: 'error', text: t`ACS URL is required.` })
      return
    }
    if (createForm.sloUrl.trim() && parseCertificates(createForm.spCertificates).length === 0) {
      setMessage({
        tone: 'error',
        text: t`SP signing certificate is required when an SLO URL is configured.`,
      })
      return
    }
    const app = await createApp.mutateAsync({
      ...toPayload(createForm),
      assignment_gate: buildAssignmentGate(
        createGateMode,
        createAllowedRoles,
        createAllowedUserIds,
      ),
    })
    setCreateForm(EMPTY_FORM)
    setCreateGateMode('all')
    setCreateAllowedRoles('')
    setCreateAllowedUserIds('')
    setSelectedId(app.id)
    setMessage({ tone: 'success', text: t`Outbound SAML app created.` })
  }

  async function handleUpdate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!selected) return
    if (editForm.sloUrl.trim() && parseCertificates(editForm.spCertificates).length === 0) {
      setMessage({
        tone: 'error',
        text: t`SP signing certificate is required when an SLO URL is configured.`,
      })
      return
    }
    await updateApp.mutateAsync({
      appId: selected.id,
      payload: {
        ...toPayload(editForm),
        assignment_gate: buildAssignmentGate(editGateMode, editAllowedRoles, editAllowedUserIds),
      },
    })
    setMessage({ tone: 'success', text: t`Outbound SAML app saved.` })
  }

  async function handleDelete(): Promise<void> {
    if (!selected) return
    await deleteApp.mutateAsync(selected.id)
    setSelectedId(null)
    setMessage({ tone: 'success', text: t`Outbound SAML app deleted.` })
  }

  if (!orgId) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  const actionError =
    createApp.error?.message || updateApp.error?.message || deleteApp.error?.message || null

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Outbound enterprise SSO</Trans>
        </h1>
        <p {...stylex.props(page.lead)}>
          <Trans>
            Configure downstream SaaS SAML service providers from preset templates. SAML/OIDC
            presets also show the downstream OIDC redirect URI placeholder for manual SaaS admin
            setup.
          </Trans>
        </p>
      </div>

      {message || actionError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone={message?.tone ?? 'error'}>{message?.text ?? actionError}</Alert>
        </div>
      ) : null}

      <section {...stylex.props(styles.tableSection)}>
        <h2 {...stylex.props(page.sectionLabel)}>
          <Trans>Apps</Trans>
        </h2>
        {isLoading ? (
          <Spinner />
        ) : isError ? (
          <Alert tone="error">
            <Trans>Failed to load outbound SAML apps.</Trans>
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            data={data ?? []}
            getRowId={(row) => row.id}
            emptyMessage={<Trans>No outbound SAML apps configured.</Trans>}
            onRowClick={(row) => setSelectedId(row.id)}
          />
        )}
      </section>

      <section {...stylex.props(styles.configSection)}>
        <h2 {...stylex.props(page.sectionLabel)}>
          <Trans>Create app</Trans>
        </h2>
        <div {...stylex.props(styles.presetRow)}>
          {OUTBOUND_CONSOLE_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="secondary"
              onClick={() => applyPreset(preset.key)}
            >
              <Trans>Add {preset.label} template</Trans>
            </Button>
          ))}
        </div>
        <form
          onSubmit={(event) => void handleCreate(event)}
          noValidate
          {...stylex.props(styles.formGrid)}
        >
          <Field label={t`SP entity ID`}>
            <Input
              value={createForm.spEntityId}
              onChange={(event) =>
                setCreateForm((prev) => ({ ...prev, spEntityId: event.target.value }))
              }
            />
          </Field>
          <Field label={t`ACS URL`}>
            <Input
              value={createForm.acsUrl}
              onChange={(event) =>
                setCreateForm((prev) => ({ ...prev, acsUrl: event.target.value }))
              }
              required
            />
          </Field>
          <Field label={t`SLO URL (optional)`}>
            <Input
              value={createForm.sloUrl}
              onChange={(event) =>
                setCreateForm((prev) => ({ ...prev, sloUrl: event.target.value }))
              }
            />
          </Field>
          <Field label={t`Binding`}>
            <select
              {...stylex.props(consoleShell.select)}
              value={createForm.sloBinding}
              onChange={(event) =>
                setCreateForm((prev) => ({
                  ...prev,
                  sloBinding: event.target.value as AppForm['sloBinding'],
                }))
              }
            >
              <option value="redirect">{t`HTTP-Redirect`}</option>
              <option value="post">{t`HTTP-POST`}</option>
            </select>
          </Field>
          <Field
            label={t`SP signing certificates`}
            hint={t`Required with an SLO URL. Paste PEM blocks or separate base64 DER certificates with a blank line.`}
          >
            <textarea
              {...stylex.props(styles.textarea)}
              value={createForm.spCertificates}
              onChange={(event) =>
                setCreateForm((prev) => ({ ...prev, spCertificates: event.target.value }))
              }
              placeholder={t`MIIC...`}
            />
          </Field>
          {createPreset?.oidcRedirectPlaceholder ? (
            <Field
              label={t`OIDC redirect URI (downstream admin)`}
              hint={
                <Trans>
                  Configure this redirect URI in the downstream SaaS OIDC app. XID stores SAML
                  fields only; OIDC client registration uses the generic OAuth app catalog.
                </Trans>
              }
            >
              <Input
                value={createForm.oidcRedirectUri}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, oidcRedirectUri: event.target.value }))
                }
              />
            </Field>
          ) : null}
          <Field label={t`Assignment mode`}>
            <select
              {...stylex.props(consoleShell.select)}
              value={createGateMode}
              onChange={(event) => setCreateGateMode(event.target.value as AssignmentGate['mode'])}
            >
              <option value="all">{t`All members`}</option>
              <option value="restricted">{t`Restricted roles`}</option>
            </select>
          </Field>
          {createGateMode === 'restricted' ? (
            <>
              <Field label={t`Allowed roles (comma-separated)`}>
                <Input
                  value={createAllowedRoles}
                  onChange={(event) => setCreateAllowedRoles(event.target.value)}
                  placeholder={t`admin, owner`}
                />
              </Field>
              <Field label={t`Allowed user IDs (comma-separated)`}>
                <Input
                  value={createAllowedUserIds}
                  onChange={(event) => setCreateAllowedUserIds(event.target.value)}
                  placeholder={t`user_abc, user_def`}
                />
              </Field>
            </>
          ) : null}
          <div {...stylex.props(styles.actions)}>
            <Button type="submit" isLoading={createApp.isPending}>
              <Trans>Create app</Trans>
            </Button>
          </div>
        </form>
      </section>

      {selected ? (
        <section {...stylex.props(styles.configSection)}>
          <h2 {...stylex.props(page.sectionLabel)}>
            <Trans>Edit app</Trans>
          </h2>
          <form
            onSubmit={(event) => void handleUpdate(event)}
            noValidate
            {...stylex.props(styles.formGrid)}
          >
            <Field label={t`SP entity ID`}>
              <Input
                value={editForm.spEntityId}
                onChange={(event) =>
                  setEditForm((prev) => ({ ...prev, spEntityId: event.target.value }))
                }
              />
            </Field>
            <Field label={t`ACS URL`}>
              <Input
                value={editForm.acsUrl}
                onChange={(event) =>
                  setEditForm((prev) => ({ ...prev, acsUrl: event.target.value }))
                }
                required
              />
            </Field>
            <Field label={t`SLO URL (optional)`}>
              <Input
                value={editForm.sloUrl}
                onChange={(event) =>
                  setEditForm((prev) => ({ ...prev, sloUrl: event.target.value }))
                }
              />
            </Field>
            <Field label={t`Binding`}>
              <select
                {...stylex.props(consoleShell.select)}
                value={editForm.sloBinding}
                onChange={(event) =>
                  setEditForm((prev) => ({
                    ...prev,
                    sloBinding: event.target.value as AppForm['sloBinding'],
                  }))
                }
              >
                <option value="redirect">{t`HTTP-Redirect`}</option>
                <option value="post">{t`HTTP-POST`}</option>
              </select>
            </Field>
            <Field
              label={t`SP signing certificates`}
              hint={t`Required with an SLO URL. Paste PEM blocks or separate base64 DER certificates with a blank line.`}
            >
              <textarea
                {...stylex.props(styles.textarea)}
                value={editForm.spCertificates}
                onChange={(event) =>
                  setEditForm((prev) => ({ ...prev, spCertificates: event.target.value }))
                }
                placeholder={t`MIIC...`}
              />
            </Field>
            {editForm.oidcRedirectUri ? (
              <Field label={t`OIDC redirect URI (downstream admin)`}>
                <Input
                  value={editForm.oidcRedirectUri}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, oidcRedirectUri: event.target.value }))
                  }
                />
              </Field>
            ) : null}
            <Field
              label={t`Assignment mode`}
              hint={
                <Trans>
                  Restricted mode limits outbound SSO launch and SCIM sync to members with selected
                  roles or explicit user IDs.
                </Trans>
              }
            >
              <select
                {...stylex.props(consoleShell.select)}
                value={editGateMode}
                onChange={(event) => setEditGateMode(event.target.value as AssignmentGate['mode'])}
              >
                <option value="all">{t`All members`}</option>
                <option value="restricted">{t`Restricted roles`}</option>
              </select>
            </Field>
            {editGateMode === 'restricted' ? (
              <>
                <Field label={t`Allowed roles (comma-separated)`}>
                  <Input
                    value={editAllowedRoles}
                    onChange={(event) => setEditAllowedRoles(event.target.value)}
                    placeholder={t`admin, owner`}
                  />
                </Field>
                <Field label={t`Allowed user IDs (comma-separated)`}>
                  <Input
                    value={editAllowedUserIds}
                    onChange={(event) => setEditAllowedUserIds(event.target.value)}
                    placeholder={t`user_abc, user_def`}
                  />
                </Field>
              </>
            ) : null}
            <div {...stylex.props(styles.actions)}>
              <Button
                type="button"
                variant="danger"
                onClick={() => void handleDelete()}
                isLoading={deleteApp.isPending}
              >
                <Trans>Delete app</Trans>
              </Button>
              <Button type="submit" isLoading={updateApp.isPending}>
                <Trans>Save app</Trans>
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  )
}
