// 配置单个社交登录提供方:侧边抽屉(窄屏全屏)。常用字段在上,端点等放在 Advanced 里。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, CopyField, Dialog, Field, Input, Switch } from '@xid-kit/web-ui/ui'
import type { XidError } from '@xid-kit/types'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { settingsStyles } from './AuthSettingsLayout'
import { providerName } from './social-provider-presets'
import type { OrgSocialProviderPolicy } from './types'

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  copyGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  label: {
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  readOnly: {
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
    overflowWrap: 'anywhere',
  },
  advanced: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    paddingTop: '0.25rem',
  },
  summary: {
    cursor: 'pointer',
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
  },
  error: {
    margin: 0,
    color: tokens['--xid-danger'],
    fontSize: text.sm,
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    width: '100%',
  },
  footerStart: {
    marginInlineEnd: 'auto',
  },
})

function listToText(value: readonly string[], separator: string): string {
  return value.join(separator)
}

function textToList(value: string, pattern: RegExp): string[] {
  return value
    .split(pattern)
    .map((item) => item.trim())
    .filter(Boolean)
}

export type SocialProviderDialogProps = {
  providerKey: string
  initial: OrgSocialProviderPolicy
  isNew: boolean
  isPending: boolean
  error: XidError | null
  onSave: (policy: OrgSocialProviderPolicy) => void
  onRemove: () => void
  onClose: () => void
}

export function SocialProviderDialog({
  providerKey,
  initial,
  isNew,
  isPending,
  error,
  onSave,
  onRemove,
  onClose,
}: SocialProviderDialogProps): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const [form, setForm] = useState(initial)
  const name = providerName(providerKey)
  const redirectUri = `${globalThis.location?.origin ?? ''}/auth/${providerKey}/callback`

  useEffect(() => setForm(initial), [initial])

  function patch(next: Partial<OrgSocialProviderPolicy>): void {
    setForm((prev) => ({ ...prev, ...next }))
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={name}
      position={{ narrow: 'fullscreen', regular: 'side' }}
      size="md"
      footer={
        <div {...stylex.props(styles.footer)}>
          {isNew ? null : (
            <span {...stylex.props(styles.footerStart)}>
              <Button type="button" variant="ghost" onClick={onRemove}>
                <Trans>Remove</Trans>
              </Button>
            </span>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" isLoading={isPending} onClick={() => onSave(form)}>
            <Trans>Save {name}</Trans>
          </Button>
        </div>
      }
    >
      <div {...stylex.props(styles.body)}>
        <Switch
          label={<Trans>Show on the sign-in page</Trans>}
          description={<Trans>Continue with {name}</Trans>}
          checked={form.enabled && form.allowLogin}
          onCheckedChange={(checked) => patch({ enabled: checked, allowLogin: checked })}
        />
        <div {...stylex.props(styles.copyGroup)}>
          <span {...stylex.props(styles.label)}>
            <Trans>Authorized redirect URI</Trans>
          </span>
          <CopyField value={redirectUri} subject={t`redirect URI`} />
          <p {...stylex.props(settingsStyles.note)}>
            <Trans>Paste this into the OAuth client you created at {name}.</Trans>
          </p>
        </div>
        <Field label={<Trans>Client ID</Trans>}>
          <Input
            value={form.clientId}
            spellCheck={false}
            onChange={(event) => patch({ clientId: event.target.value.trim() })}
          />
        </Field>
        <div {...stylex.props(styles.copyGroup)}>
          <span {...stylex.props(styles.label)}>
            <Trans>Client secret</Trans>
          </span>
          <p {...stylex.props(styles.readOnly)}>
            {form.clientSecretRef ? (
              <Trans>Set by your instance operator as {form.clientSecretRef}</Trans>
            ) : (
              <Trans>Your instance operator has not set a secret for this provider yet.</Trans>
            )}
          </p>
        </div>
        <Field label={<Trans>Scopes</Trans>}>
          <Input
            value={listToText(form.scopes, ' ')}
            spellCheck={false}
            onChange={(event) => patch({ scopes: textToList(event.target.value, /[\s,]+/) })}
          />
        </Field>
        <Field label={<Trans>Only allow these email domains</Trans>}>
          <Input
            value={listToText(form.allowedEmailDomains, ', ')}
            placeholder={t`Any ${name} account`}
            onChange={(event) =>
              patch({
                allowedEmailDomains: textToList(event.target.value.toLowerCase(), /[\s,]+/),
              })
            }
          />
        </Field>
        <details>
          <summary {...stylex.props(styles.summary)}>
            <Trans>Advanced</Trans>
          </summary>
          <div {...stylex.props(styles.advanced)}>
            <Switch
              label={<Trans>Create an account on first sign-in</Trans>}
              checked={form.allowUserCreation}
              onCheckedChange={(checked) => patch({ allowUserCreation: checked })}
            />
            <Switch
              label={<Trans>Require a verified email from {name}</Trans>}
              checked={form.requireVerifiedEmail}
              onCheckedChange={(checked) => patch({ requireVerifiedEmail: checked })}
            />
            <Switch
              label={<Trans>Use PKCE</Trans>}
              checked={form.usesPkce}
              onCheckedChange={(checked) => patch({ usesPkce: checked })}
            />
            <Field label={<Trans>Block these email domains</Trans>}>
              <Input
                value={listToText(form.blockedEmailDomains, ', ')}
                onChange={(event) =>
                  patch({
                    blockedEmailDomains: textToList(event.target.value.toLowerCase(), /[\s,]+/),
                  })
                }
              />
            </Field>
            <Field label={<Trans>Authorization endpoint</Trans>}>
              <Input
                value={form.authorizationEndpoint}
                onChange={(event) => patch({ authorizationEndpoint: event.target.value.trim() })}
              />
            </Field>
            <Field label={<Trans>Token endpoint</Trans>}>
              <Input
                value={form.tokenEndpoint}
                onChange={(event) => patch({ tokenEndpoint: event.target.value.trim() })}
              />
            </Field>
            <Field label={<Trans>Userinfo endpoint</Trans>}>
              <Input
                value={form.userInfoEndpoint ?? ''}
                onChange={(event) => patch({ userInfoEndpoint: event.target.value.trim() })}
              />
            </Field>
            <Field
              label={<Trans>Issuer</Trans>}
              hint={
                <Trans>
                  Each enabled provider needs an issuer with a JWKS URI, or a userinfo endpoint.
                </Trans>
              }
            >
              <Input
                value={form.issuer ?? ''}
                onChange={(event) => patch({ issuer: event.target.value.trim() })}
              />
            </Field>
            <Field label={<Trans>JWKS URI</Trans>}>
              <Input
                value={form.jwksUri ?? ''}
                onChange={(event) => patch({ jwksUri: event.target.value.trim() })}
              />
            </Field>
            <Field label={<Trans>External ID claim</Trans>}>
              <Input
                value={form.externalIdClaim ?? ''}
                onChange={(event) => patch({ externalIdClaim: event.target.value.trim() })}
              />
            </Field>
          </div>
        </details>
        {error ? (
          <p role="alert" {...stylex.props(styles.error)}>
            {errorMessage(error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
