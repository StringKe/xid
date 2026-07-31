// platform console Instance 默认策略页:GET/PATCH /v1/platform/settings。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + 5/7 双列表单(SplitSection)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Select, Spinner } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSplitSection } from '@xid-kit/web-ui/ui'
import { usePlatformSettingsQuery, useUpdatePlatformSettings } from './queries'
import type { PlatformSettings as PlatformSettingsType } from './types'

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

  const settings = settingsQuery.data

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!form) return
    updateMutation.mutate(form)
  }

  return (
    <ConsolePage
      title={<Trans>Platform settings</Trans>}
      lead={<Trans>Instance-wide defaults inherited by organizations unless overridden.</Trans>}
    >
      {settingsQuery.isError || updateMutation.isError || updateMutation.isSuccess ? (
        <ConsolePageNotice>
          {settingsQuery.isError ? (
            <Alert tone="error">
              <Trans>Failed to load platform settings.</Trans>
            </Alert>
          ) : null}
          {updateMutation.isError ? (
            <Alert tone="error">
              <Trans>Failed to save settings. Try again.</Trans>
            </Alert>
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
        {!form ? (
          <div {...stylex.props(styles.loadingZone)}>
            {settingsQuery.isError ? null : <Spinner size={28} />}
          </div>
        ) : (
          <form {...stylex.props(styles.form)} onSubmit={onSubmit}>
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
              <Select
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
              </Select>
            </Field>

            <div>
              <Button type="submit" isLoading={updateMutation.isPending}>
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </form>
        )}
      </ConsolePageSplitSection>
    </ConsolePage>
  )
}
