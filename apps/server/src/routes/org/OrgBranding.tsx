// org 品牌定制页:颜色/字体/logo URL 设置。调 GET/PATCH /v1/organizations/:orgId/branding。
// 实时预览走 CSS 变量;logo 存储由 URL 字段接入。
// 数据层:useOrgBrandingQuery(read) + useUpdateOrgBranding(mutation)。
// 布局:5/7 双列分区 -- 左节题与说明,右控件;预览区 inline 在控件列内。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Spinner } from '../../components/ui'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { useOrgBrandingQuery, useUpdateOrgBranding } from './queries'
import type { OrgBranding } from './types'
import { useOrgTarget } from './useOrgTarget'

// 全宽规范常量
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

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
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  formBody: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  // 每个配置节:5/7 双列 + hairline 顶
  configSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 64rem)': '0',
    },
  },
  sectionMeta: {
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  sectionDesc: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    maxWidth: '28rem',
  },
  controlCol: {
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    maxWidth: '36rem',
  },
  // 颜色/字体:2 列 auto-fill 网格
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
  // 色彩预览带:hairline 顶分隔
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
  submitSection: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    display: 'flex',
    justifyContent: 'flex-end',
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
  const hasColors = form.primaryColor ?? form.backgroundColor ?? form.accentColor
  if (!hasColors && !form.logoUrl) return null
  return (
    <div {...stylex.props(styles.previewStrip)}>
      <p {...stylex.props(page.sectionLabel)}>
        <Trans>Preview</Trans>
      </p>
      {hasColors ? (
        <div {...stylex.props(styles.previewSwatch)}>
          <ColorSwatch color={form.primaryColor} label="primary" />
          <ColorSwatch color={form.backgroundColor} label="bg" />
          <ColorSwatch color={form.accentColor} label="accent" />
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

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!orgId) return
    setSaveSuccess(false)
    await updateBranding.mutateAsync(form)
    setSaveSuccess(true)
  }

  if (!orgId) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div {...stylex.props(page.loadingCenter)}>
        <Spinner label={t`Loading branding settings`} />
      </div>
    )
  }

  if (isError) {
    return (
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="error">
          <Trans>Failed to load branding settings.</Trans>
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Brand customization</Trans>
        </h1>
      </div>

      {updateBranding.error ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">{updateBranding.error.message}</Alert>
        </div>
      ) : null}
      {saveSuccess ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="success">
            <Trans>Branding saved successfully.</Trans>
          </Alert>
        </div>
      ) : null}

      <form onSubmit={(e) => void handleSave(e)} noValidate {...stylex.props(styles.formBody)}>
        {/* Colors */}
        <section aria-labelledby="branding-colors-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="branding-colors-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Colors</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Override the organization's primary, background, and accent colors for the Hosted
                UI. Accepts CSS hex values.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            <div {...stylex.props(styles.colorsGrid)}>
              <Field
                label={<Trans>Primary color</Trans>}
                hint={<Trans>Hex color, e.g. #6366f1</Trans>}
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
              <Field label={<Trans>Background color</Trans>}>
                <Input
                  type="text"
                  value={form.backgroundColor ?? ''}
                  onChange={(e) => patch('backgroundColor', e.target.value || null)}
                  placeholder={t`#ffffff`}
                  aria-label={t`Background color`}
                />
              </Field>
              <Field label={<Trans>Accent color</Trans>}>
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
          </div>
        </section>

        {/* Typography and shape */}
        <section
          aria-labelledby="branding-typography-heading"
          {...stylex.props(styles.configSection)}
        >
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="branding-typography-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Typography and shape</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Override the font family and border radius used throughout the Hosted UI for this
                organization.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            <div {...stylex.props(styles.colorsGrid)}>
              <Field label={<Trans>Font family</Trans>} hint={<Trans>CSS font-family value</Trans>}>
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
              >
                <Input
                  type="text"
                  value={form.borderRadius ?? ''}
                  onChange={(e) => patch('borderRadius', e.target.value || null)}
                  placeholder={t`8px`}
                />
              </Field>
            </div>
          </div>
        </section>

        {/* Logo */}
        <section aria-labelledby="branding-logo-heading" {...stylex.props(styles.configSection)}>
          <div {...stylex.props(styles.sectionMeta)}>
            <h2 id="branding-logo-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Logo</Trans>
            </h2>
            <p {...stylex.props(styles.sectionDesc)}>
              <Trans>
                Provide separate light and dark logo URLs. Both are hosted externally and referenced
                by URL.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.controlCol)}>
            <div {...stylex.props(styles.logoGrid)}>
              <Field label={<Trans>Logo URL (light)</Trans>}>
                <Input
                  type="url"
                  value={form.logoUrl ?? ''}
                  onChange={(e) => patch('logoUrl', e.target.value || null)}
                  placeholder={t`https://...`}
                />
              </Field>
              <Field label={<Trans>Logo URL (dark)</Trans>}>
                <Input
                  type="url"
                  value={form.logoDarkUrl ?? ''}
                  onChange={(e) => patch('logoDarkUrl', e.target.value || null)}
                  placeholder={t`https://...`}
                />
              </Field>
            </div>
            <BrandPreviewStrip form={{ logoUrl: form.logoUrl }} />
          </div>
        </section>

        <div {...stylex.props(styles.submitSection)}>
          <Button type="submit" isLoading={updateBranding.isPending}>
            <Trans>Save changes</Trans>
          </Button>
        </div>
      </form>
    </div>
  )
}
