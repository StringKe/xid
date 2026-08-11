// org 下游企业 SSO 页:从 preset 模板配置下游 SaaS SAML SP,支持 SLO 与成员分配门控。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;创建/编辑表单 5/7 双列(SplitSection)。

import { Trans, useLingui } from '@lingui/react/macro'
import { OUTBOUND_CONSOLE_PRESETS } from '@xid-kit/protocol'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Button, Field, Input, Select, Textarea } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  useCreateOutboundSamlApp,
  useDeleteOutboundSamlApp,
  useOrgOutboundSamlAppsQuery,
  useUpdateOutboundSamlApp,
} from './queries'
import type { AssignmentGate, CreateOutboundSamlAppInput, OutboundSamlApp } from './types'
import { useOrgTarget } from './useOrgTarget'

const styles = stylex.create({
  presetRow: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  formGrid: { display: 'grid', gap: '1rem' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' },
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
      <span {...stylex.props(consoleShell.mono)}>
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
  const [pendingDelete, setPendingDelete] = useState(false)
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
    setPendingDelete(false)
    setMessage({ tone: 'success', text: t`Outbound SAML app deleted.` })
  }

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Outbound enterprise SSO</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  const actionError = createApp.isError || updateApp.isError || deleteApp.isError

  return (
    <ConsolePage
      title={<Trans>Outbound enterprise SSO</Trans>}
      lead={
        <Trans>
          Configure downstream SaaS SAML service providers from preset templates. SAML/OIDC presets
          also show the downstream OIDC redirect URI placeholder for manual SaaS admin setup.
        </Trans>
      }
    >
      {message || actionError || isError ? (
        <ConsolePageNotice>
          {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
          {actionError ? (
            <Alert tone="error">
              <Trans>Failed to save outbound SAML app changes. Try again.</Trans>
            </Alert>
          ) : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load outbound SAML apps.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Apps</Trans>}>
        <DataTable
          columns={columns}
          data={data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No outbound SAML apps configured.</Trans>}
          onRowClick={(row) => setSelectedId(row.id)}
          isRowSelected={(row) => row.id === selectedId}
        />
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Create app</Trans>}
        description={
          <Trans>
            Register a downstream SAML service provider from a preset template and choose which
            members can launch it.
          </Trans>
        }
      >
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
            <Select
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
            </Select>
          </Field>
          <Field
            label={t`SP signing certificates`}
            hint={t`Required with an SLO URL. Paste PEM blocks or separate base64 DER certificates with a blank line.`}
          >
            <Textarea
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
            <Select
              value={createGateMode}
              onChange={(event) => setCreateGateMode(event.target.value as AssignmentGate['mode'])}
            >
              <option value="all">{t`All members`}</option>
              <option value="restricted">{t`Restricted roles`}</option>
            </Select>
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
      </ConsolePageSplitSection>

      {selected ? (
        <ConsolePageSplitSection
          title={<Trans>Edit app</Trans>}
          meta={<p {...stylex.props(consoleShell.selectorSummary)}>{selected.provider}</p>}
        >
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
              <Select
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
              </Select>
            </Field>
            <Field
              label={t`SP signing certificates`}
              hint={t`Required with an SLO URL. Paste PEM blocks or separate base64 DER certificates with a blank line.`}
            >
              <Textarea
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
              <Select
                value={editGateMode}
                onChange={(event) => setEditGateMode(event.target.value as AssignmentGate['mode'])}
              >
                <option value="all">{t`All members`}</option>
                <option value="restricted">{t`Restricted roles`}</option>
              </Select>
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
              <Button type="submit" isLoading={updateApp.isPending}>
                <Trans>Save changes</Trans>
              </Button>
              <Button type="button" variant="danger" onClick={() => setPendingDelete(true)}>
                <Trans>Delete app</Trans>
              </Button>
            </div>
          </form>
        </ConsolePageSplitSection>
      ) : null}

      {pendingDelete && selected ? (
        <ConfirmDialog
          title={<Trans>Delete app?</Trans>}
          description={
            <Trans>
              {selected.provider} ({selected.spEntityId}) will be deleted. Members can no longer use
              this SAML application.
            </Trans>
          }
          confirmLabel={<Trans>Delete app</Trans>}
          isLoading={deleteApp.isPending}
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(false)}
        />
      ) : null}
    </ConsolePage>
  )
}
