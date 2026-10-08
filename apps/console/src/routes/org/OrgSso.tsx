import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import {
  useCreateSsoConnection,
  useDeleteSsoConnection,
  useOrgSsoConnectionsQuery,
  useUpdateSsoConnection,
} from './queries'
import { SsoConnectionEndpoints } from './SsoConnectionEndpoints'
import { SsoConnectionCreate } from './SsoConnectionCreate'
import { ConnectionFields, ssoFormStyles } from './SsoConnectionFields'
import { useSsoConnectionColumns } from './useSsoConnectionColumns'
import { EMPTY_FORM, connectionToForm, createPayload, updatePayload } from './sso-connection-form'
import type { ConnectionForm, SsoProtocol } from './sso-connection-form'
import { useOrgSelfServiceLocked, useOrgTarget } from './useOrgTarget'
import { LockableFieldset, SelfServiceLockNotice } from './SelfServiceLock'

const styles = stylex.create({
  tableFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '0.75rem',
    marginTop: '0.75rem',
  },
})

export default function OrgSso(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const locked = useOrgSelfServiceLocked()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgSsoConnectionsQuery(orgId)
  const createConnection = useCreateSsoConnection(orgId)
  const updateConnection = useUpdateSsoConnection(orgId)
  const deleteConnection = useDeleteSsoConnection(orgId)
  const columns = useSsoConnectionColumns()
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const selectedConnection = data?.find((connection) => connection.id === selectedId) ?? null
  const hasConnection = (data?.length ?? 0) > 0

  useEffect(() => {
    if (!selectedConnection && data && data.length > 0) setSelectedId(data[0]!.id)
  }, [data, selectedConnection])

  useEffect(() => {
    if (selectedConnection) setEditForm(connectionToForm(selectedConnection))
  }, [selectedConnection])

  function resetMessages(): void {
    setFormError(null)
    setSuccess(null)
  }

  function handleCreateFromPreset(presetKey: string, protocol: SsoProtocol): void {
    resetMessages()
    createConnection.mutate(
      { preset: presetKey, protocol },
      {
        onSuccess: (connection) => {
          setCreating(false)
          setSelectedId(connection.id)
          setSuccess(t`SSO connection created from template.`)
        },
      },
    )
  }

  function handleCreate(form: ConnectionForm, onDone: () => void): void {
    resetMessages()
    const payload = createPayload(form)
    if (!payload) {
      setFormError(t`Attribute mapping and role mapping must be JSON objects.`)
      return
    }
    createConnection.mutate(payload, {
      onSuccess: (connection) => {
        onDone()
        setCreating(false)
        setSelectedId(connection.id)
        setSuccess(t`SSO connection created.`)
      },
    })
  }

  function handleUpdate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!selectedConnection) return
    resetMessages()
    const payload = updatePayload(editForm)
    if (!payload) {
      setFormError(t`Attribute mapping and role mapping must be JSON objects.`)
      return
    }
    updateConnection.mutate(
      { connectionId: selectedConnection.id, payload },
      { onSuccess: () => setSuccess(t`SSO connection saved.`) },
    )
  }

  function handleDelete(): void {
    if (!selectedConnection) return
    resetMessages()
    deleteConnection.mutate(selectedConnection.id, {
      onSuccess: () => {
        setSelectedId(null)
        setSuccess(t`SSO connection deleted.`)
      },
      onSettled: () => setPendingDelete(false),
    })
  }

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Inbound SSO connections</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  const actionError = createConnection.error ?? updateConnection.error ?? deleteConnection.error

  return (
    <ConsolePage
      wide
      title={<Trans>Inbound SSO connections</Trans>}
      lead={
        <Trans>
          Manage SAML, OIDC, and legacy enterprise identity provider connections for this
          organization.
        </Trans>
      }
    >
      {locked || formError || success || actionError || isError ? (
        <ConsolePageNotice>
          {locked ? <SelfServiceLockNotice /> : null}
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          {success ? <Alert tone="success">{success}</Alert> : null}
          {actionError ? <Alert tone="error">{errorMessage(actionError)}</Alert> : null}
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load inbound SSO connections. Reload the page to try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Connections</Trans>}>
        <DataTable
          columns={columns}
          data={data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No inbound SSO connections configured.</Trans>}
          onRowClick={(row) => setSelectedId(row.id)}
          isRowSelected={(row) => row.id === selectedId}
        />
        {data && !creating ? (
          <div {...stylex.props(styles.tableFooter)}>
            {hasConnection ? (
              <p {...stylex.props(consoleShell.sectionDescription)}>
                <Trans>
                  Each organization has one inbound connection. Delete it before adding another.
                </Trans>
              </p>
            ) : (
              <Button type="button" disabled={locked} onClick={() => setCreating(true)}>
                <Trans>Add connection</Trans>
              </Button>
            )}
          </div>
        ) : null}
      </ConsolePageSection>

      {creating && !hasConnection ? (
        <SsoConnectionCreate
          locked={locked}
          isPending={createConnection.isPending}
          onCreateFromPreset={handleCreateFromPreset}
          onCreate={handleCreate}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {selectedConnection ? (
        <ConsolePageSplitSection
          title={<Trans>Edit connection</Trans>}
          meta={<p {...stylex.props(consoleShell.selectorSummary)}>{selectedConnection.name}</p>}
          description={
            <Trans>Enter these XID service provider values in your identity provider.</Trans>
          }
        >
          <SsoConnectionEndpoints connection={selectedConnection} />
          <form onSubmit={handleUpdate} noValidate>
            <LockableFieldset locked={locked}>
              <div {...stylex.props(ssoFormStyles.formGrid)}>
                <ConnectionFields
                  form={editForm}
                  onChange={setEditForm}
                  allowProtocolSwitch={false}
                />
                <div {...stylex.props(ssoFormStyles.fullSpan, ssoFormStyles.actions)}>
                  <Button type="button" variant="ghost" onClick={() => setPendingDelete(true)}>
                    <Trans>Delete connection</Trans>
                  </Button>
                  <Button type="submit" isLoading={updateConnection.isPending}>
                    <Trans>Save changes</Trans>
                  </Button>
                </div>
              </div>
            </LockableFieldset>
          </form>
        </ConsolePageSplitSection>
      ) : null}

      {pendingDelete && selectedConnection ? (
        <ConfirmDialog
          title={<Trans>Delete connection?</Trans>}
          description={
            <Trans>
              {selectedConnection.name} will be deleted. Users can no longer sign in through this
              connection.
            </Trans>
          }
          confirmLabel={<Trans>Delete connection</Trans>}
          isLoading={deleteConnection.isPending}
          onConfirm={handleDelete}
          onCancel={() => setPendingDelete(false)}
        />
      ) : null}
    </ConsolePage>
  )
}
