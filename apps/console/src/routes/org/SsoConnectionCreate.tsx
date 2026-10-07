import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, ConsolePageSplitSection } from '@xid-kit/web-ui/ui'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { LockableFieldset } from './SelfServiceLock'
import { ConnectionFields, ssoFormStyles } from './SsoConnectionFields'
import { EMPTY_FORM, INBOUND_PRESETS, LEGACY_PRESETS } from './sso-connection-form'
import type { ConnectionForm, SsoProtocol } from './sso-connection-form'

const styles = stylex.create({
  presetRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
})

export type SsoConnectionCreateProps = {
  locked: boolean
  isPending: boolean
  onCreateFromPreset: (presetKey: string, protocol: SsoProtocol) => void
  onCreate: (form: ConnectionForm, onDone: () => void) => void
  onCancel: () => void
}

export function SsoConnectionCreate({
  locked,
  isPending,
  onCreateFromPreset,
  onCreate,
  onCancel,
}: SsoConnectionCreateProps): ReactNode {
  const { i18n } = useLingui()
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM)

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onCreate(form, () => setForm(EMPTY_FORM))
  }

  return (
    <ConsolePageSplitSection
      title={<Trans>Add connection</Trans>}
      description={
        <Trans>
          Register SAML, OIDC, or legacy enterprise protocol connections for this organization.
          Legacy protocols use the <code {...stylex.props(consoleShell.mono)}>_legacy</code> JSON
          helper in attribute mapping.
        </Trans>
      }
    >
      <LockableFieldset locked={locked}>
        <div {...stylex.props(styles.presetRow)}>
          {INBOUND_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="secondary"
              onClick={() => onCreateFromPreset(preset.key, 'saml')}
              isLoading={isPending}
            >
              <Trans>Add {preset.label} template</Trans>
            </Button>
          ))}
          {LEGACY_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="secondary"
              onClick={() => onCreateFromPreset(preset.key, preset.key)}
              isLoading={isPending}
            >
              <Trans>Add {i18n._(preset.label)} template</Trans>
            </Button>
          ))}
        </div>
        <form onSubmit={handleSubmit} noValidate>
          <div {...stylex.props(ssoFormStyles.formGrid)}>
            <ConnectionFields form={form} onChange={setForm} allowProtocolSwitch />
            <div {...stylex.props(ssoFormStyles.fullSpan, ssoFormStyles.actions)}>
              <Button type="button" variant="ghost" onClick={onCancel}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" isLoading={isPending}>
                <Trans>Create connection</Trans>
              </Button>
            </div>
          </div>
        </form>
      </LockableFieldset>
    </ConsolePageSplitSection>
  )
}
