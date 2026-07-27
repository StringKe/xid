// platform console Instance 默认策略页:GET/PATCH /v1/platform/settings。

import { Trans, useLingui } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { usePlatformSettingsQuery, useUpdatePlatformSettings } from './queries'
import type { PlatformSettings as PlatformSettingsType } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

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
  lead: {
    margin: '0.375rem 0 0',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    textWrap: 'pretty',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  formSection: {
    paddingInline: GUTTER,
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
    display: 'grid',
    gap: '1rem',
    maxWidth: '36rem',
  },
  select: {
    width: '100%',
    padding: '0.625rem 0.75rem',
    borderRadius: tokens['--xid-radius-sm'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontSize: '0.9375rem',
    fontFamily: tokens['--xid-font'],
  },
})

type FormState = {
  defaultLocale: string
  dataResidency: string
  mfaPolicy: PlatformSettingsType['mfaPolicy']
}

function toFormState(settings: PlatformSettingsType): FormState {
  return {
    defaultLocale: settings.defaultLocale,
    dataResidency: settings.dataResidency,
    mfaPolicy: settings.mfaPolicy,
  }
}

export default function PlatformSettingsPage(): ReactNode {
  const { t } = useLingui()
  const settingsQuery = usePlatformSettingsQuery()
  const updateMutation = useUpdatePlatformSettings()
  const [form, setForm] = useState<FormState | null>(null)

  useEffect(() => {
    if (settingsQuery.data) setForm(toFormState(settingsQuery.data))
  }, [settingsQuery.data])

  if (settingsQuery.isLoading || !form) {
    return (
      <div {...stylex.props(styles.root)}>
        <div {...stylex.props(styles.messageZone)}>
          <Spinner size={28} />
        </div>
      </div>
    )
  }

  if (settingsQuery.isError) {
    return (
      <div {...stylex.props(styles.root)}>
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{settingsQuery.error.message}</Alert>
        </div>
      </div>
    )
  }

  const settings = settingsQuery.data

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    updateMutation.mutate(form)
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Platform settings</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>Instance-wide defaults inherited by organizations unless overridden.</Trans>
        </p>
      </div>

      {updateMutation.isError || updateMutation.isSuccess ? (
        <div {...stylex.props(styles.messageZone)}>
          {updateMutation.isError ? (
            <Alert tone="error">{updateMutation.error.message}</Alert>
          ) : null}
          {updateMutation.isSuccess ? (
            <Alert tone="success">
              <Trans>Settings saved.</Trans>
            </Alert>
          ) : null}
        </div>
      ) : null}

      <form {...stylex.props(styles.formSection)} onSubmit={onSubmit}>
        <Field label={t`Instance`}>
          <Input value={settings?.name ?? ''} readOnly />
        </Field>

        <Field label={t`Default locale`}>
          <Input
            value={form.defaultLocale}
            onChange={(event) =>
              setForm((current) =>
                current ? { ...current, defaultLocale: event.target.value } : current,
              )
            }
          />
        </Field>

        <Field label={t`Data residency`}>
          <Input
            value={form.dataResidency}
            onChange={(event) =>
              setForm((current) =>
                current ? { ...current, dataResidency: event.target.value } : current,
              )
            }
          />
        </Field>

        <Field label={t`Platform MFA policy`}>
          <select
            {...stylex.props(styles.select)}
            value={form.mfaPolicy}
            onChange={(event) =>
              setForm((current) =>
                current
                  ? {
                      ...current,
                      mfaPolicy: event.target.value as PlatformSettingsType['mfaPolicy'],
                    }
                  : current,
              )
            }
          >
            <option value="optional">{t`Optional`}</option>
            <option value="required">{t`Required`}</option>
            <option value="disabled">{t`Disabled`}</option>
          </select>
        </Field>

        <Button type="submit" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? <Trans>Saving…</Trans> : <Trans>Save settings</Trans>}
        </Button>
      </form>
    </div>
  )
}
