import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import {
  BRAND_COLOR_SCHEMES,
  BRAND_RADII,
  brandAccentOf,
  sameOrgBranding,
  type BrandColorScheme,
  type BrandRadius,
  type OrgBranding as OrgBrandingValues,
} from '@xid-kit/types'
import {
  Alert,
  Badge,
  Button,
  ConsolePage,
  ConsolePageNotice,
  Icon,
  Spinner,
} from '@xid-kit/web-ui/ui'
import { SegmentedControl } from '@xid-kit/web-ui/ui/SegmentedControl'
import { Tabs } from '@xid-kit/web-ui/ui/Tabs'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { darkTheme, lightTheme, tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { formatDateTime } from '../../lib/date-format'
import { formatRelative } from '../users/user-format'
import { BrandPreview, type PreviewScheme } from './BrandPreview'
import {
  useBrandingQuery,
  usePublishBranding,
  useSaveBrandingDraft,
  useUploadBrandLogo,
  type BrandingEnvelope,
  type LogoVariant,
} from './brand-queries'
import {
  brandContrastChecks,
  formatContrastRatio,
  suggestAccessibleAccent,
  type BrandContrastCheck,
} from './contrast'
import { useOrgTarget } from './useOrgTarget'

const HEX_DIGITS = /^[0-9a-fA-F]{6}$/

const styles = stylex.create({
  center: { display: 'flex', justifyContent: 'center', paddingBlock: '2.25rem' },
  titleRow: { display: 'inline-flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' },
  headerActions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: { default: 'stretch', '@media (min-width: 48rem)': 'flex-end' },
    gap: '0.375rem',
  },
  buttons: { display: 'flex', gap: '0.5rem' },
  meta: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    fontVariantNumeric: 'tabular-nums',
  },
  zone: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  tabs: { display: { default: 'block', '@media (min-width: 64rem)': 'none' } },
  body: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 28.75rem) minmax(0, 1fr)',
    },
    gap: '2.5rem',
    alignItems: 'start',
  },
  hiddenNarrow: { display: { default: 'none', '@media (min-width: 64rem)': 'flex' } },
  settings: { display: 'flex', flexDirection: 'column', gap: '1.75rem', minWidth: 0 },
  preview: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    minWidth: 0,
    position: { default: 'static', '@media (min-width: 64rem)': 'sticky' },
    top: '1.5rem',
  },
  group: { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  hairline: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingTop: '1.5rem',
  },
  logoFirst: { order: { default: 1, '@media (min-width: 64rem)': 0 } },
  accentGroup: { order: { default: 0, '@media (min-width: 64rem)': 1 } },
  shapeGroup: { order: 2 },
  groupTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.md,
    fontWeight: weight.medium,
    lineHeight: '1.375rem',
  },
  groupHint: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
  logoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' },
  logoCell: { display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0 },
  logoTile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    height: '5.5rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    color: tokens['--xid-fg'],
  },
  logoImage: { display: 'block', maxHeight: '3rem', maxWidth: '100%', objectFit: 'contain' },
  logoInitial: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.625rem',
    height: '1.625rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
    fontSize: text.sm,
    fontWeight: weight.display,
  },
  logoName: {
    fontSize: text.md,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  logoFoot: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: text.sm,
  },
  linkButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-accent'],
    fontFamily: 'inherit',
    fontSize: text.sm,
    cursor: 'pointer',
  },
  hiddenInput: { display: 'none' },
  accentRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  swatch: {
    width: '2.5rem',
    height: '2.5rem',
    flexShrink: 0,
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  hexField: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: { default: '100%', '@media (min-width: 30rem)': '10rem' },
    flexGrow: { default: 1, '@media (min-width: 30rem)': 0 },
    height: '2.5rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
  },
  hexFieldInvalid: { boxShadow: `inset 0 0 0 2px ${tokens['--xid-danger']}` },
  hash: { color: tokens['--xid-muted-foreground'], fontSize: text.base },
  hexInput: {
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.base,
    textTransform: 'uppercase',
  },
  errorText: {
    margin: 0,
    color: tokens['--xid-danger'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
  checks: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  check: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: '2.5rem',
    paddingInline: '0.75rem',
    borderBottomWidth: { default: '1px', ':last-child': '0' },
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.sm,
  },
  checkLabel: { flexGrow: 1, minWidth: 0 },
  checkRatio: {
    width: '3.5rem',
    flexShrink: 0,
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
  },
  checkResult: { width: '4rem', flexShrink: 0, fontSize: text.xs, fontWeight: weight.medium },
  pass: { color: tokens['--xid-success'] },
  fail: { color: tokens['--xid-danger'] },
  previewHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  previewNote: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  noteIcon: { color: tokens['--xid-danger'], flexShrink: 0 },
})

type ViewTab = 'settings' | 'preview'

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? ''
}

function GroupHeading({ title, hint }: { title: ReactNode; hint: ReactNode }): ReactNode {
  return (
    <div>
      <h2 {...stylex.props(styles.groupTitle)}>{title}</h2>
      <p {...stylex.props(styles.groupHint)}>{hint}</p>
    </div>
  )
}

function LogoCell(props: {
  variant: LogoVariant
  url: string | null
  orgName: string
  isUploading: boolean
  onUpload: (variant: LogoVariant, file: File) => void
}): ReactNode {
  const { t } = useLingui()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const label = props.variant === 'dark' ? <Trans>On dark</Trans> : <Trans>On light</Trans>
  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    if (file) props.onUpload(props.variant, file)
    event.target.value = ''
  }
  return (
    <div {...stylex.props(styles.logoCell)}>
      <div {...stylex.props(props.variant === 'dark' ? darkTheme : lightTheme, styles.logoTile)}>
        {props.url ? (
          <img src={props.url} alt="" {...stylex.props(styles.logoImage)} />
        ) : (
          <>
            <span aria-hidden="true" {...stylex.props(styles.logoInitial)}>
              {initialOf(props.orgName)}
            </span>
            <span {...stylex.props(styles.logoName)}>{props.orgName}</span>
          </>
        )}
      </div>
      <div {...stylex.props(styles.logoFoot)}>
        <span>{label}</span>
        {props.isUploading ? (
          <Spinner size={16} label={t`Uploading logo`} />
        ) : (
          <button
            type="button"
            {...stylex.props(styles.linkButton)}
            onClick={() => inputRef.current?.click()}
            aria-controls={inputId}
          >
            <Trans>Replace…</Trans>
          </button>
        )}
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept="image/svg+xml,image/png"
          aria-label={
            props.variant === 'dark' ? t`Logo for dark backgrounds` : t`Logo for light backgrounds`
          }
          {...stylex.props(styles.hiddenInput)}
          onChange={handleChange}
        />
      </div>
    </div>
  )
}

function ContrastRows({ checks }: { checks: BrandContrastCheck[] }): ReactNode {
  return (
    <div {...stylex.props(styles.checks)}>
      {checks.map((check) => (
        <div key={check.key} {...stylex.props(styles.check)}>
          <span {...stylex.props(styles.checkLabel)}>
            {check.key === 'button_text' ? (
              <Trans>Button text on accent</Trans>
            ) : check.key === 'link' ? (
              <Trans>Links, using the derived darker shade</Trans>
            ) : (
              <Trans>Focus ring on dark background</Trans>
            )}
          </span>
          <span {...stylex.props(styles.checkRatio)}>{formatContrastRatio(check.ratio)}:1</span>
          <span {...stylex.props(styles.checkResult, check.passes ? styles.pass : styles.fail)}>
            {check.passes ? <Trans>Passes</Trans> : <Trans>Needs {check.minimum}</Trans>}
          </span>
        </div>
      ))}
    </div>
  )
}

function AccentSection(props: {
  accent: string | null
  onChange: (accent: string | null) => void
  checks: BrandContrastCheck[]
}): ReactNode {
  const { t } = useLingui()
  const [input, setInput] = useState(props.accent?.slice(1) ?? '')
  useEffect(() => setInput(props.accent?.slice(1) ?? ''), [props.accent])
  const buttonCheck = props.checks.find((check) => check.key === 'button_text')
  const failing = props.checks.some((check) => !check.passes)
  const malformed = input !== '' && !HEX_DIGITS.test(input)
  function handleInput(value: string): void {
    const next = value.replace(/^#/, '').trim()
    setInput(next)
    if (next === '') props.onChange(null)
    else if (HEX_DIGITS.test(next)) props.onChange(`#${next.toUpperCase()}`)
  }
  return (
    <div {...stylex.props(styles.group, styles.hairline, styles.accentGroup)}>
      <GroupHeading
        title={<Trans>Accent color</Trans>}
        hint={
          <Trans>
            Used for the main button, links and focus rings. XID derives hover, border and
            background shades from it.
          </Trans>
        }
      />
      <div {...stylex.props(styles.accentRow)}>
        <span
          aria-hidden="true"
          {...stylex.props(styles.swatch)}
          style={props.accent ? { backgroundColor: props.accent } : undefined}
        />
        <label {...stylex.props(styles.hexField, (failing || malformed) && styles.hexFieldInvalid)}>
          <span {...stylex.props(styles.hash)}>#</span>
          <input
            value={input}
            onChange={(event) => handleInput(event.target.value)}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-label={t`Accent color hex value`}
            aria-invalid={failing || malformed}
            placeholder={t`Default`}
            {...stylex.props(styles.hexInput)}
          />
        </label>
        {buttonCheck ? (
          <Badge tone={buttonCheck.passes ? 'success' : 'danger'}>
            {buttonCheck.passes ? (
              <Trans>{formatContrastRatio(buttonCheck.ratio)}:1, passes</Trans>
            ) : (
              <Trans>{formatContrastRatio(buttonCheck.ratio)}:1, fails</Trans>
            )}
          </Badge>
        ) : null}
      </div>
      {malformed ? (
        <p {...stylex.props(styles.errorText)}>
          <Trans>Enter six hex digits, for example 8C6400.</Trans>
        </p>
      ) : buttonCheck && !buttonCheck.passes ? (
        <p {...stylex.props(styles.errorText)}>
          <Trans>
            Too light for white button text. Pick a darker shade, at least 4.5:1 against white.
          </Trans>
        </p>
      ) : null}
      {props.checks.length > 0 ? <ContrastRows checks={props.checks} /> : null}
    </div>
  )
}

function ShapeSection(props: {
  form: OrgBrandingValues
  onChange: (patch: Partial<OrgBrandingValues>) => void
}): ReactNode {
  const { t } = useLingui()
  const radiusLabels: Record<BrandRadius, ReactNode> = {
    square: <Trans>Square</Trans>,
    small: <Trans>Small</Trans>,
    medium: <Trans>Medium</Trans>,
    round: <Trans>Round</Trans>,
  }
  const schemeLabels: Record<BrandColorScheme, ReactNode> = {
    light: <Trans>Light only</Trans>,
    dark: <Trans>Dark only</Trans>,
    system: <Trans>Follow device</Trans>,
  }
  return (
    <div {...stylex.props(styles.group, styles.hairline, styles.shapeGroup)}>
      <GroupHeading
        title={<Trans>Corners</Trans>}
        hint={<Trans>Applies to buttons, inputs and the sign-in card.</Trans>}
      />
      <div>
        <SegmentedControl
          ariaLabel={t`Corners`}
          value={props.form.borderRadius ?? 'medium'}
          onValueChange={(value) => props.onChange({ borderRadius: value as BrandRadius })}
          options={BRAND_RADII.map((value) => ({ value, label: radiusLabels[value] }))}
        />
      </div>
      <GroupHeading
        title={<Trans>Color scheme</Trans>}
        hint={<Trans>Follow device lets each user&apos;s system setting decide.</Trans>}
      />
      <div>
        <SegmentedControl
          ariaLabel={t`Color scheme`}
          value={props.form.colorScheme ?? 'system'}
          onValueChange={(value) => props.onChange({ colorScheme: value as BrandColorScheme })}
          options={BRAND_COLOR_SCHEMES.map((value) => ({ value, label: schemeLabels[value] }))}
        />
      </div>
    </div>
  )
}

function changedFields(
  base: OrgBrandingValues,
  form: OrgBrandingValues,
): Partial<OrgBrandingValues> {
  const patch: Partial<OrgBrandingValues> = {}
  for (const key of Object.keys(form) as (keyof OrgBrandingValues)[]) {
    if (form[key] !== base[key]) Object.assign(patch, { [key]: form[key] })
  }
  return patch
}

function StatusMeta({ data, dirty }: { data: BrandingEnvelope; dirty: boolean }): ReactNode {
  const { i18n } = useLingui()
  const published = data.publishedAt ? formatDateTime(i18n, data.publishedAt) : null
  if (dirty) return <Trans>Changes not saved yet.</Trans>
  if (data.hasUnpublishedChanges) {
    const saved = formatRelative(i18n, data.draftUpdatedAt) ?? ''
    return published ? (
      <Trans>
        Draft saved {saved}. Live version published {published}.
      </Trans>
    ) : (
      <Trans>Draft saved {saved}. Nothing published yet.</Trans>
    )
  }
  if (!published) return <Trans>Using the default look. Nothing unpublished.</Trans>
  const name = data.publishedBy?.displayName
  return name ? (
    <Trans>
      Published {published} by {name}. Nothing unpublished.
    </Trans>
  ) : (
    <Trans>Published {published}. Nothing unpublished.</Trans>
  )
}

function BlockedNotice(props: {
  accent: string
  check: BrandContrastCheck
  onUseSuggestion: (accent: string) => void
}): ReactNode {
  const suggestion = suggestAccessibleAccent(props.accent)
  const ratio = formatContrastRatio(props.check.ratio)
  const accent = props.accent.toUpperCase()
  return (
    <Alert
      tone="error"
      title={<Trans>This draft can&apos;t be published yet</Trans>}
      action={
        suggestion ? (
          <Button variant="secondary" onClick={() => props.onUseSuggestion(suggestion)}>
            <Trans>Use {suggestion} instead</Trans>
          </Button>
        ) : null
      }
    >
      {props.check.key === 'button_text' ? (
        <Trans>
          White button text on the accent color {accent} has a contrast of {ratio}:1. Sign-in
          buttons need at least 4.5:1 so everyone can read them. Your live sign-in pages are
          unchanged.
        </Trans>
      ) : (
        <Trans>
          The accent color {accent} reaches {ratio}:1 where sign-in pages need {props.check.minimum}
          :1. Your live sign-in pages are unchanged.
        </Trans>
      )}
    </Alert>
  )
}

export default function OrgBranding(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { orgId, activeOrg } = useOrgTarget()
  const orgName = activeOrg?.name ?? ''
  const query = useBrandingQuery(orgId)
  const saveDraft = useSaveBrandingDraft(orgId)
  const publish = usePublishBranding(orgId)
  const uploadLogo = useUploadBrandLogo(orgId)
  const [form, setForm] = useState<OrgBrandingValues | null>(null)
  const [tab, setTab] = useState<ViewTab>('settings')
  const [previewScheme, setPreviewScheme] = useState<PreviewScheme>('light')

  const data = query.data
  const base = data ? (data.draft ?? data.published) : null
  const syncedBase = useRef<OrgBrandingValues | null>(null)
  // 本地有未保存改动时只带入服务端新的 logo,refetch 不覆盖正在编辑的值。
  useEffect(() => {
    if (!base) return
    const previous = syncedBase.current
    syncedBase.current = base
    setForm((current) =>
      current && previous && !sameOrgBranding(current, previous)
        ? { ...current, logoUrl: base.logoUrl, logoDarkUrl: base.logoDarkUrl }
        : base,
    )
  }, [base])

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Branding</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  if (!data || !form || !base) {
    return (
      <ConsolePage title={<Trans>Branding</Trans>}>
        {query.isError ? (
          <ConsolePageNotice>
            <Alert tone="error">
              <Trans>Failed to load branding settings. Reload the page to try again.</Trans>
            </Alert>
          </ConsolePageNotice>
        ) : (
          <div {...stylex.props(styles.center)}>
            <Spinner label={t`Loading branding settings`} />
          </div>
        )}
      </ConsolePage>
    )
  }

  const dirty = !sameOrgBranding(form, base)
  const accent = brandAccentOf(form)
  const checks = accent ? brandContrastChecks(accent) : []
  const failingCheck = checks.find((check) => !check.passes) ?? null
  const failingChecks = checks.filter((check) => !check.passes).length
  const unpublished = dirty || data.hasUnpublishedChanges
  const canPublish = unpublished && !failingCheck
  const mutationError = saveDraft.error ?? publish.error ?? uploadLogo.error

  function patch(values: Partial<OrgBrandingValues>): void {
    setForm((current) => (current ? { ...current, ...values } : current))
  }

  function setAccent(value: string | null): void {
    patch({ accentColor: value, primaryColor: null })
  }

  // 失败由 mutation.error 渲染到页面,这里只结束流程。
  async function saveCurrent(): Promise<BrandingEnvelope | null> {
    if (!form || !base || !dirty) return data ?? null
    return saveDraft.mutateAsync(changedFields(base, form)).catch(() => null)
  }

  async function handlePublish(): Promise<void> {
    if (!canPublish) return
    const saved = await saveCurrent()
    // 改回已发布值时服务端会清掉草稿,无可发布内容。
    if (!saved?.hasUnpublishedChanges) return
    await publish.mutateAsync().catch(() => undefined)
  }

  const header = (
    <span {...stylex.props(styles.titleRow)}>
      <Trans>Branding</Trans>
      {unpublished ? (
        <Badge>
          <Trans>Unpublished changes</Trans>
        </Badge>
      ) : (
        <Badge tone="success">
          <Trans>Live</Trans>
        </Badge>
      )}
    </span>
  )

  const actions = (
    <div {...stylex.props(styles.headerActions)}>
      <div {...stylex.props(styles.buttons)}>
        <Button
          variant="secondary"
          aria-disabled={!dirty}
          isLoading={saveDraft.isPending}
          onClick={() => void saveCurrent()}
        >
          <Trans>Save draft</Trans>
        </Button>
        <Button
          aria-disabled={!canPublish}
          isLoading={publish.isPending}
          onClick={() => void handlePublish()}
        >
          <Trans>Publish</Trans>
        </Button>
      </div>
      <p {...stylex.props(styles.meta)}>
        <StatusMeta data={data} dirty={dirty} />
      </p>
    </div>
  )

  const settings = (
    <div {...stylex.props(styles.settings, tab !== 'settings' && styles.hiddenNarrow)}>
      <div {...stylex.props(styles.group, styles.logoFirst)}>
        <GroupHeading
          title={<Trans>Logo</Trans>}
          hint={<Trans>SVG or PNG, at least 96 px tall. Shown above the sign-in form.</Trans>}
        />
        <div {...stylex.props(styles.logoGrid)}>
          {(['light', 'dark'] as const).map((variant) => (
            <LogoCell
              key={variant}
              variant={variant}
              url={variant === 'dark' ? (form.logoDarkUrl ?? form.logoUrl) : form.logoUrl}
              orgName={orgName}
              isUploading={uploadLogo.isPending && uploadLogo.variables?.variant === variant}
              onUpload={(next, file) => uploadLogo.mutate({ variant: next, file })}
            />
          ))}
        </div>
      </div>
      <AccentSection accent={accent} onChange={setAccent} checks={checks} />
      <ShapeSection form={form} onChange={patch} />
    </div>
  )

  const preview = (
    <div {...stylex.props(styles.preview, tab !== 'preview' && styles.hiddenNarrow)}>
      <div {...stylex.props(styles.previewHead)}>
        <h2 {...stylex.props(styles.groupTitle)}>
          {unpublished ? (
            <Trans>Preview of your draft</Trans>
          ) : (
            <Trans>Preview of the live version</Trans>
          )}
        </h2>
        <SegmentedControl
          ariaLabel={t`Preview color scheme`}
          value={previewScheme}
          onValueChange={(value) => setPreviewScheme(value as PreviewScheme)}
          options={[
            { value: 'light', label: <Trans>Light</Trans> },
            { value: 'dark', label: <Trans>Dark</Trans> },
          ]}
        />
      </div>
      <BrandPreview
        branding={form}
        orgName={orgName}
        host={data.signInHost}
        scheme={previewScheme}
      />
      {failingCheck?.key === 'button_text' ? (
        <p {...stylex.props(styles.previewNote)}>
          <span {...stylex.props(styles.noteIcon)}>
            <Icon name="alert-circle" size={14} />
          </span>
          <Trans>
            Continue is hard to read on this accent. Publishing stays blocked until it reaches
            4.5:1.
          </Trans>
        </p>
      ) : null}
    </div>
  )

  return (
    <ConsolePage
      title={header}
      lead={
        <Trans>
          How the sign-in pages at {data.signInHost} look to your users. Changes stay in a draft
          until you publish them.
        </Trans>
      }
      actions={actions}
    >
      <div {...stylex.props(styles.zone)}>
        {mutationError ? <Alert tone="error">{errorMessage(mutationError)}</Alert> : null}
        {accent && failingCheck ? (
          <BlockedNotice accent={accent} check={failingCheck} onUseSuggestion={setAccent} />
        ) : null}
        <div {...stylex.props(styles.tabs)}>
          <Tabs
            ariaLabel={t`Branding views`}
            value={tab}
            onValueChange={(value) => setTab(value as ViewTab)}
            items={[
              {
                value: 'settings',
                label: (
                  <>
                    <Trans>Settings</Trans>
                    {failingChecks > 0 ? (
                      <Badge tone="danger">
                        <Plural value={failingChecks} one="# issue" other="# issues" />
                      </Badge>
                    ) : null}
                  </>
                ),
              },
              { value: 'preview', label: <Trans>Preview</Trans> },
            ]}
          />
        </div>
        <div {...stylex.props(styles.body)}>
          {settings}
          {preview}
        </div>
      </div>
    </ConsolePage>
  )
}
