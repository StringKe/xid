// Sign-in & MFA 的「Passkey attestation」分节:证明要求与租户可信根(列表、整包替换、全部移除)。
// direct 必须先有可信根(实例级或租户级),与服务端保存校验一致。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Alert, Button, Field, Textarea } from '@xid-kit/web-ui/ui'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { SaveButton, SettingsBlock, settingsStyles } from './AuthSettingsLayout'
import { ChoiceCards, SaveStatus } from './AuthSettingsControls'
import {
  useRemoveTrustedRoots,
  useReplaceTrustedRoots,
  useSaveOrgAuthPolicy,
  useTrustedRoots,
} from './auth-queries'
import type { OrgAuthPolicyView, TrustedRoot } from './auth-queries'
import type { AttestationMode } from './types'
import { useIsTenantScopeOrg } from './useOrgTarget'

const styles = stylex.create({
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  rootRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  fingerprint: {
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  },
  validity: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.75rem',
  },
})

function RootRow({ root }: { root: TrustedRoot }): ReactNode {
  const { i18n } = useLingui()
  const from = i18n.date(new Date(root.notBefore), { dateStyle: 'medium' })
  const until = i18n.date(new Date(root.notAfter), { dateStyle: 'medium' })
  return (
    <li {...stylex.props(styles.rootRow)}>
      <span {...stylex.props(styles.fingerprint)}>{root.fingerprint}</span>
      <span {...stylex.props(styles.validity)}>
        <Trans>
          Valid from {from} to {until}
        </Trans>
      </span>
    </li>
  )
}

function TrustedRootsManager({ orgId }: { orgId: string }): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const roots = useTrustedRoots(true)
  const replace = useReplaceTrustedRoots(orgId)
  const remove = useRemoveTrustedRoots(orgId)
  const [pem, setPem] = useState('')
  const [replaced, setReplaced] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const list = roots.data?.data ?? []

  function submitPem(): void {
    setReplaced(false)
    replace.mutate(pem, {
      onSuccess: () => {
        setPem('')
        setReplaced(true)
      },
    })
  }

  return (
    <div {...stylex.props(styles.group)}>
      <h3 {...stylex.props(settingsStyles.subTitle)}>
        <Trans>Trusted roots</Trans>
      </h3>
      {roots.isError ? (
        <Alert tone="error">
          <Trans>Trusted roots could not be loaded. Reload the page to try again.</Trans>
        </Alert>
      ) : list.length > 0 ? (
        <ul {...stylex.props(settingsStyles.rows)}>
          {list.map((root) => (
            <RootRow key={root.fingerprint} root={root} />
          ))}
        </ul>
      ) : roots.isLoading ? null : (
        <p {...stylex.props(settingsStyles.note)}>
          <Trans>No trusted roots for this tenant yet.</Trans>
        </p>
      )}
      <Field
        label={<Trans>Root certificates (PEM)</Trans>}
        hint={
          <Trans>
            Paste every root certificate you accept, from your security key vendors. Saving replaces
            the whole list. Only CA certificates that are valid today are accepted.
          </Trans>
        }
      >
        <Textarea
          value={pem}
          spellCheck={false}
          placeholder={t`-----BEGIN CERTIFICATE-----`}
          onChange={(event) => setPem(event.target.value)}
        />
      </Field>
      <div {...stylex.props(styles.actions)}>
        <Button
          type="button"
          variant="secondary"
          isLoading={replace.isPending}
          disabled={pem.trim() === ''}
          onClick={submitPem}
        >
          <Trans>Replace trusted roots</Trans>
        </Button>
        {list.length > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
            <Trans>Remove all trusted roots</Trans>
          </Button>
        ) : null}
      </div>
      <SaveStatus error={replace.error} saved={replaced} />
      {confirming ? (
        <ConfirmDialog
          title={<Trans>Remove all trusted roots?</Trans>}
          description={
            <Trans>
              Passkeys that are already registered keep working. While attestation is required, new
              passkeys can be registered only against roots the instance itself provides.
            </Trans>
          }
          confirmLabel={<Trans>Remove trusted roots</Trans>}
          isLoading={remove.isPending}
          error={errorMessage(remove.error)}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => setConfirming(false) })}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  )
}

export function AttestationSection({
  orgId,
  policy,
}: {
  orgId: string
  policy: OrgAuthPolicyView
}): ReactNode {
  const { t } = useLingui()
  const canManageRoots = useIsTenantScopeOrg()
  const current = policy.hostedAuth.attestationMode ?? 'none'
  const [mode, setMode] = useState<AttestationMode>(current)
  const [saved, setSaved] = useState(false)
  const mutation = useSaveOrgAuthPolicy(orgId)
  const rootsReady = policy.attestationRootsConfigured

  useEffect(() => setMode(current), [current])

  function submit(): void {
    setSaved(false)
    mutation.mutate(
      { hostedAuth: { ...policy.hostedAuth, attestationMode: mode } },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <SettingsBlock
      id="attestation"
      onSubmit={submit}
      title={<Trans>Passkey attestation</Trans>}
      description={
        <Trans>
          Attestation is a signed statement from the device about which security key or platform
          created a passkey. Most organizations do not require it.
        </Trans>
      }
    >
      <ChoiceCards<AttestationMode>
        legend={t`Passkey attestation`}
        value={mode}
        onChange={setMode}
        options={[
          {
            value: 'none',
            label: <Trans>Not required</Trans>,
            description: <Trans>Any passkey can be registered.</Trans>,
          },
          {
            value: 'indirect',
            label: <Trans>Check when present</Trans>,
            description: (
              <Trans>
                Passkeys whose attestation chains to a trusted root are marked as verified. Passkeys
                without one are still accepted.
              </Trans>
            ),
          },
          {
            value: 'direct',
            label: <Trans>Required</Trans>,
            description: rootsReady ? (
              <Trans>
                Only passkeys whose attestation chains to a trusted root can be registered. Most
                synced passkeys from phones and password managers send no attestation and are
                refused.
              </Trans>
            ) : (
              <Trans>Add trusted roots first. Without them no passkey could be registered.</Trans>
            ),
            disabled: !rootsReady && current !== 'direct',
          },
        ]}
      />
      {current === 'direct' && !rootsReady ? (
        <Alert tone="warning">
          <Trans>
            Attestation is required but no trusted roots are configured, so no one can register a
            passkey. Add trusted roots or choose another option.
          </Trans>
        </Alert>
      ) : null}
      <SaveButton isPending={mutation.isPending}>
        <Trans>Save attestation</Trans>
      </SaveButton>
      <SaveStatus error={mutation.error} saved={saved} />
      {canManageRoots ? (
        <TrustedRootsManager orgId={orgId} />
      ) : (
        <p {...stylex.props(settingsStyles.note)}>
          <Trans>
            Trusted roots apply to every organization in this tenant. A manager of the top-level
            organization adds them.
          </Trans>
        </p>
      )}
    </SettingsBlock>
  )
}
