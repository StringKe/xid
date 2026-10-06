import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Spinner } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { ORG_BRANDING_FIELDS } from '@xid-kit/types'
import { errorTargetsField, useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useOrgBrandingQuery, useUpdateOrgBranding } from './queries'
import type { OrgBranding } from './types'
import { useOrgTarget } from './useOrgTarget'

const styles = stylex.create({
  loadingZone: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '2.25rem',
  },
  colorsGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 28rem)': 'repeat(auto-fill, minmax(12rem, 1fr))',
    },
    gap: '1rem',
  },
  logoGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 28rem)': '1fr 1fr',
    },
    gap: '1rem',
  },
  previewStrip: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingTop: '0.875rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  previewSwatch: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  swatch: {
    width: '2.5rem',
    height: '2.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    flexShrink: 0,
  },
  previewLabel: {
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.04em',
  },
  swatchItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    alignItems: 'center',
  },
})

function ColorSwatch({
  color,
  label,
}: {
  color: string | null | undefined
  label: string
}): ReactNode {
  if (!color) return null
  return (
    <div {...stylex.props(styles.swatchItem)}>
      <div {...stylex.props(styles.swatch)} style={{ backgroundColor: color }} />
      <span {...stylex.props(styles.previewLabel)}>{label}</span>
    </div>
  )
}

function BrandPreviewStrip({ form }: { form: Partial<OrgBranding> }): ReactNode {
  const { t } = useLingui()
  const hasColors = form.primaryColor ?? form.backgroundColor ?? form.accentColor
  if (!hasColors && !form.logoUrl) return null
  return (
    <div {...stylex.props(styles.previewStrip)}>
      <p {...stylex.props(page.sectionLabel)}>
        <Trans>Preview</Trans>
      </p>
      {hasColors ? (
        <div {...stylex.props(styles.previewSwatch)}>
          <ColorSwatch color={form.primaryColor} label={t`Primary`} />
          <ColorSwatch color={form.backgroundColor} label={t`Background`} />
          <ColorSwatch color={form.accentColor} label={t`Accent`} />
        </div>
      ) : null}
      {form.logoUrl ? (
        <img
          src={form.logoUrl}
          alt=""
          style={{ maxHeight: '3rem', maxWidth: '12rem', objectFit: 'contain' }}
        />
      ) : null}
    </div>
  )
}

export default function OrgBranding(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { orgId } = useOrgTarget()
  const { data, isLoading, isError } = useOrgBrandingQuery(orgId)
  const updateBranding = useUpdateOrgBranding(orgId)

  const [form, setForm] = useState<Partial<OrgBranding>>({})
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  function patch<K extends keyof OrgBranding>(key: K, value: OrgBranding[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleSave(e: FormEvent): void {
    e.preventDefault()
    if (!orgId) return
    setSaveSuccess(false)
    updateBranding.mutate(form, { onSuccess: () => setSaveSuccess(true) })
  }

  const saveError = updateBranding.error
  const fieldError = (field: keyof OrgBranding): string | undefined =>
    errorTargetsField(saveError, field) ? errorMessage(saveError) : undefined
  const formError =
    saveError && !ORG_BRANDING_FIELDS.some((field) => errorTargetsField(saveError, field))
      ? errorMessage(saveError)
      : undefined

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Brand customization</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage
      title={<Trans>Brand customization</Trans>}
      lead={
        <Trans>
          Colors, typography, and logo overrides for this organization&apos;s Hosted UI.
        </Trans>
      }
    >
      {isError || formError || saveSuccess ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load branding settings.</Trans>
            </Alert>
          ) : null}
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          {saveSuccess ? (
            <Alert tone="success">
              <Trans>Branding saved successfully.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      {!data ? (
        <ConsolePageSection>
          <div {...stylex.props(styles.loadingZone)}>
            {isLoading ? <Spinner label={t`Loading branding settings`} /> : null}
          </div>
        </ConsolePageSection>
      ) : (
        <form onSubmit={handleSave} noValidate>
          <ConsolePageSplitSection
            title={<Trans>Colors</Trans>}
            description={
              <Trans>
                Override the organization's primary, background, and accent colors on its sign-in
                and account pages. Accepts six-digit hex values. The background color applies to the
                light theme only. Clear a field to return to the default.
              </Trans>
            }
          >
            <div {...stylex.props(styles.colorsGrid)}>
              <Field
                label={<Trans>Primary color</Trans>}
                hint={<Trans>Hex color, e.g. #6366f1</Trans>}
                error={fieldError('primaryColor')}
              >
                <Input
                  type="text"
                  value={form.primaryColor ?? ''}
                  onChange={(e) => patch('primaryColor', e.target.value || null)}
                  placeholder={t`#6366f1`}
                  pattern="^#[0-9a-fA-F]{6}$"
                  aria-label={t`Primary brand color`}
                />
              </Field>
              <Field
                label={<Trans>Background color (light theme)</Trans>}
                error={fieldError('backgroundColor')}
              >
                <Input
                  type="text"
                  value={form.backgroundColor ?? ''}
                  onChange={(e) => patch('backgroundColor', e.target.value || null)}
                  placeholder={t`#ffffff`}
                  aria-label={t`Background color`}
                />
              </Field>
              <Field label={<Trans>Accent color</Trans>} error={fieldError('accentColor')}>
                <Input
                  type="text"
                  value={form.accentColor ?? ''}
                  onChange={(e) => patch('accentColor', e.target.value || null)}
                  placeholder={t`#10b981`}
                  aria-label={t`Accent color`}
                />
              </Field>
            </div>
            <BrandPreviewStrip form={form} />
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Typography and shape</Trans>}
            description={
              <Trans>
                Override the font family and border radius used on this organization's sign-in and
                account pages. The font must already be available on the visitor's device.
              </Trans>
            }
          >
            <div {...stylex.props(styles.colorsGrid)}>
              <Field
                label={<Trans>Font family</Trans>}
                hint={<Trans>Font names separated by commas</Trans>}
                error={fieldError('fontFamily')}
              >
                <Input
                  type="text"
                  value={form.fontFamily ?? ''}
                  onChange={(e) => patch('fontFamily', e.target.value || null)}
                  placeholder={t`Inter, system-ui, sans-serif`}
                />
              </Field>
              <Field
                label={<Trans>Border radius</Trans>}
                hint={<Trans>CSS length, e.g. 8px or 0.5rem</Trans>}
                error={fieldError('borderRadius')}
              >
                <Input
                  type="text"
                  value={form.borderRadius ?? ''}
                  onChange={(e) => patch('borderRadius', e.target.value || null)}
                  placeholder={t`8px`}
                />
              </Field>
            </div>
          </ConsolePageSplitSection>

          <ConsolePageSplitSection
            title={<Trans>Logo</Trans>}
            description={
              <Trans>
                Provide separate light and dark logo URLs. Both must be public HTTPS URLs; the light
                logo is also shown on the consent page.
              </Trans>
            }
          >
            <div {...stylex.props(styles.logoGrid)}>
              <Field label={<Trans>Logo URL (light)</Trans>} error={fieldError('logoUrl')}>
                <Input
                  type="url"
                  value={form.logoUrl ?? ''}
                  onChange={(e) => patch('logoUrl', e.target.value || null)}
                  placeholder={t`https://...`}
                />
              </Field>
              <Field label={<Trans>Logo URL (dark)</Trans>} error={fieldError('logoDarkUrl')}>
                <Input
                  type="url"
                  value={form.logoDarkUrl ?? ''}
                  onChange={(e) => patch('logoDarkUrl', e.target.value || null)}
                  placeholder={t`https://...`}
                />
              </Field>
            </div>
            <BrandPreviewStrip form={{ logoUrl: form.logoUrl }} />
            <div>
              <Button type="submit" isLoading={updateBranding.isPending}>
                <Trans>Save changes</Trans>
              </Button>
            </div>
          </ConsolePageSplitSection>
        </form>
      )}
    </ConsolePage>
  )
}
