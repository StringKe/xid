import { Trans, useLingui } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { PlatformMfaPolicy, PlatformSettings, PlatformSettingsPatch } from '@xid-kit/types'
import { Alert, Button, Field, Input, Select, Spinner } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSplitSection } from '@xid-kit/web-ui/ui'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { LOCALE_LABELS, SUPPORTED_LOCALES, isSupportedLocale } from '@xid-kit/web-ui/locale'
import type { SupportedLocale } from '@xid-kit/web-ui/locale'
import { usePlatformSettingsQuery, useUpdatePlatformSettings } from './queries'

const styles = stylex.create({
  form: {
    display: 'grid',
    gap: '1rem',
  },
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '2.25rem',
  },
})

type FormState = {
  defaultLocale: SupportedLocale
  mfaPolicy: PlatformMfaPolicy
}

function toFormState(settings: PlatformSettings): FormState {
  return {
    defaultLocale: isSupportedLocale(settings.defaultLocale) ? settings.defaultLocale : 'en',
    mfaPolicy: settings.mfaPolicy,
  }
}

function changedFields(form: FormState, settings: PlatformSettings): PlatformSettingsPatch {
  return {
    ...(form.defaultLocale !== settings.defaultLocale ? { defaultLocale: form.defaultLocale } : {}),
    ...(form.mfaPolicy !== settings.mfaPolicy ? { mfaPolicy: form.mfaPolicy } : {}),
  }
}

export default function PlatformSettingsPage(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const settingsQuery = usePlatformSettingsQuery()
  const updateMutation = useUpdatePlatformSettings()
  const [form, setForm] = useState<FormState | null>(null)

  useEffect(() => {
    if (settingsQuery.data) setForm(toFormState(settingsQuery.data))
  }, [settingsQuery.data])

  const settings = settingsQuery.data
  const patch = form && settings ? changedFields(form, settings) : {}
  const hasChanges = Object.keys(patch).length > 0

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!hasChanges) return
    updateMutation.mutate(patch)
  }

  return (
    <ConsolePage
      title={<Trans>Platform settings</Trans>}
      lead={<Trans>Instance-wide defaults inherited by organizations unless overridden.</Trans>}
    >
      {settingsQuery.isError || updateMutation.error || updateMutation.isSuccess ? (
        <ConsolePageNotice>
          {settingsQuery.isError ? (
            <Alert tone="error">
              <Trans>Failed to load platform settings.</Trans>
            </Alert>
          ) : null}
          {updateMutation.error ? (
            <Alert tone="error">{errorMessage(updateMutation.error, { surface: 'general' })}</Alert>
          ) : null}
          {updateMutation.isSuccess ? (
            <Alert tone="success">
              <Trans>Settings saved.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSplitSection
        title={<Trans>Instance defaults</Trans>}
        description={
          <Trans>These defaults apply to every organization unless it overrides them.</Trans>
        }
      >
        {!form || !settings ? (
          <div {...stylex.props(styles.loadingZone)}>
            {settingsQuery.isError ? null : <Spinner size={28} />}
          </div>
        ) : (
          <form {...stylex.props(styles.form)} onSubmit={onSubmit}>
            <Field label={t`Instance`}>
              <Input value={settings.name} readOnly />
            </Field>

            <Field
              label={t`Fallback language`}
              hint={
                <Trans>
                  Used for API error messages and transactional email when the visitor's browser
                  language is not supported. The sign-in pages and Console follow the browser
                  language.
                </Trans>
              }
            >
              <Select
                value={form.defaultLocale}
                onChange={(event) => {
                  const value = event.target.value
                  if (!isSupportedLocale(value)) return
                  setForm((current) => (current ? { ...current, defaultLocale: value } : current))
                }}
              >
                {SUPPORTED_LOCALES.map((locale) => (
                  <option key={locale} value={locale}>
                    {LOCALE_LABELS[locale]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t`Data residency label`}
              hint={
                <Trans>
                  Recorded at deployment as metadata. It does not move or restrict where data is
                  stored, so it cannot be changed here.
                </Trans>
              }
            >
              <Input value={settings.dataResidency} readOnly />
            </Field>

            <Field label={t`Platform MFA policy`}>
              <Select
                value={form.mfaPolicy}
                onChange={(event) =>
                  setForm((current) =>
                    current
                      ? { ...current, mfaPolicy: event.target.value as PlatformMfaPolicy }
                      : current,
                  )
                }
              >
                <option value="optional">{t`Optional`}</option>
                <option value="required">{t`Required`}</option>
                <option value="disabled">{t`Disabled`}</option>
              </Select>
            </Field>

            <div>
              <Button type="submit" isLoading={updateMutation.isPending} disabled={!hasChanges}>
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </form>
        )}
      </ConsolePageSplitSection>
    </ConsolePage>
  )
}
