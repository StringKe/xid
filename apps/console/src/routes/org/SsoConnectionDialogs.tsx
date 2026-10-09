// SSO 连接详情的编辑对话框:替换 IdP 设置、追加签名证书(新旧证书在旧证书到期前同时受信)。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Dialog, Field, Textarea } from '@xid-kit/web-ui/ui'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { useUpdateSsoConnection } from './queries'
import { ConnectionFields, ssoFormStyles } from './SsoConnectionFields'
import { connectionToForm, updatePayload } from './sso-connection-form'
import type { ConnectionForm } from './sso-connection-form'
import type { SsoConnectionView } from './auth-queries'

const styles = stylex.create({
  error: {
    margin: 0,
    color: tokens['--xid-danger'],
    fontSize: text.sm,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    width: '100%',
  },
})

const PEM_MARKERS = /-----(BEGIN|END) CERTIFICATE-----/g

function certificateBody(value: string): string {
  return value.replace(PEM_MARKERS, '').replace(/\s+/g, '')
}

type DialogProps = {
  orgId: string
  connection: SsoConnectionView
  onClose: () => void
}

function DialogFooter({
  formId,
  isPending,
  onClose,
  label,
}: {
  formId: string
  isPending: boolean
  onClose: () => void
  label: ReactNode
}): ReactNode {
  return (
    <div {...stylex.props(styles.footer)}>
      <Button type="button" variant="secondary" onClick={onClose}>
        <Trans>Cancel</Trans>
      </Button>
      <Button type="submit" form={formId} isLoading={isPending}>
        {label}
      </Button>
    </div>
  )
}

export function SsoSettingsDialog({ orgId, connection, onClose }: DialogProps): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateSsoConnection(orgId)
  const [form, setForm] = useState<ConnectionForm>(() => connectionToForm(connection))
  const [formError, setFormError] = useState<string | null>(null)

  function submit(): void {
    const payload = updatePayload(form)
    if (!payload) {
      setFormError(t`Attribute mapping and role mapping must be JSON objects.`)
      return
    }
    setFormError(null)
    update.mutate({ connectionId: connection.id, payload }, { onSuccess: onClose })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={<Trans>Edit {connection.name}</Trans>}
      position={{ narrow: 'fullscreen', regular: 'side' }}
      size="lg"
      footer={
        <DialogFooter
          formId="sso-settings-form"
          isPending={update.isPending}
          onClose={onClose}
          label={<Trans>Save connection</Trans>}
        />
      }
    >
      <form
        id="sso-settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div {...stylex.props(ssoFormStyles.formGrid)}>
          <ConnectionFields form={form} onChange={setForm} allowProtocolSwitch={false} />
          {formError || update.error ? (
            <p role="alert" {...stylex.props(ssoFormStyles.fullSpan, styles.error)}>
              {formError ?? (update.error ? errorMessage(update.error) : null)}
            </p>
          ) : null}
        </div>
      </form>
    </Dialog>
  )
}

export function SsoCertificateDialog({ orgId, connection, onClose }: DialogProps): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const update = useUpdateSsoConnection(orgId)
  const [value, setValue] = useState('')

  function submit(): void {
    const next = certificateBody(value)
    if (!next) return
    update.mutate(
      {
        connectionId: connection.id,
        payload: { idp_certificates: [...connection.idp_certificates, next] },
      },
      { onSuccess: onClose },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={<Trans>Upload signing certificate</Trans>}
      description={
        <Trans>
          Paste the new certificate from {connection.name}. XID trusts both certificates until the
          old one expires.
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
      footer={
        <DialogFooter
          formId="sso-certificate-form"
          isPending={update.isPending}
          onClose={onClose}
          label={<Trans>Add certificate</Trans>}
        />
      }
    >
      <form
        id="sso-certificate-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Field
          label={<Trans>Certificate</Trans>}
          error={update.error ? errorMessage(update.error) : undefined}
        >
          <Textarea
            value={value}
            rows={8}
            spellCheck={false}
            placeholder={t`-----BEGIN CERTIFICATE-----`}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  )
}
