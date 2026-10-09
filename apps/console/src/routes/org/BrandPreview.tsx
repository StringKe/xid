// 托管登录页的静态预览:强调色、圆角、logo 与 Hosted UI 同一派生规则(@xid-kit/web-ui/brand-color)。
// 预览按所选配色挂 lightTheme / darkTheme,不随 Console 自身的明暗;浅色按钮保留原始强调色,让对比度问题直接可见。

import { Trans, useLingui } from '@lingui/react/macro'
import type { CSSProperties, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { BRAND_RADIUS_CSS, brandAccentOf, type OrgBranding } from '@xid-kit/types'
import { deriveAccentPalette } from '@xid-kit/web-ui/brand-color'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { darkTheme, lightTheme, tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

export type PreviewScheme = 'light' | 'dark'

const styles = stylex.create({
  frame: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'clip',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-sidebar'],
  },
  addressBar: {
    display: 'flex',
    alignItems: 'center',
    height: '2.25rem',
    paddingInline: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  address: {
    flexGrow: 1,
    minWidth: 0,
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: '1.375rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  page: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 48rem)': 'row' },
    minHeight: { default: 'auto', '@media (min-width: 48rem)': '31.25rem' },
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  context: {
    display: 'flex',
    flexDirection: { default: 'row', '@media (min-width: 48rem)': 'column' },
    alignItems: { default: 'center', '@media (min-width: 48rem)': 'stretch' },
    justifyContent: 'space-between',
    gap: '0.75rem',
    flexShrink: 0,
    width: { default: 'auto', '@media (min-width: 48rem)': '14.25rem' },
    paddingBlock: { default: '0.75rem', '@media (min-width: 48rem)': '1.5rem' },
    paddingInline: { default: '1rem', '@media (min-width: 48rem)': '1.375rem' },
  },
  contextBody: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    flexDirection: 'column',
    gap: '0.5rem',
  },
  contextShort: {
    display: { default: 'block', '@media (min-width: 48rem)': 'none' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    textAlign: 'end',
  },
  contextFooter: {
    display: { default: 'none', '@media (min-width: 48rem)': 'flex' },
    justifyContent: 'space-between',
    paddingTop: '0.625rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
  },
  brandTile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '1.375rem',
    height: '1.375rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
    fontSize: text.xs,
    fontWeight: weight.display,
  },
  brandName: {
    fontSize: text.sm,
    fontWeight: weight.display,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  logo: {
    display: 'block',
    height: '1.375rem',
    maxWidth: '8rem',
    objectFit: 'contain',
  },
  muted: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    lineHeight: '1rem',
  },
  appName: {
    margin: 0,
    fontSize: text.xl,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
    lineHeight: '2rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: '0.875rem',
    flexGrow: 1,
    minWidth: 0,
    paddingInline: { default: '1rem', '@media (min-width: 48rem)': '2.75rem' },
    paddingBlock: '1.5rem',
    backgroundColor: tokens['--xid-surface'],
  },
  heading: {
    margin: 0,
    fontSize: text.lg,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
    lineHeight: '1.5rem',
  },
  row: {
    display: 'flex',
    gap: '0.25rem',
    flexWrap: 'wrap',
    fontSize: text.xs,
  },
  label: {
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    height: '2.125rem',
    paddingInline: '0.625rem',
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    color: tokens['--xid-faint-foreground'],
    fontSize: text.xs,
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.375rem',
    height: '2.125rem',
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  secondaryButton: {
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: tokens['--xid-faint-foreground'],
    fontSize: text.xs,
  },
  rule: {
    flexGrow: 1,
    height: '1px',
    backgroundColor: tokens['--xid-border'],
  },
  footerLinks: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
})

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? ''
}

function BrandMark({
  branding,
  orgName,
  scheme,
}: {
  branding: OrgBranding
  orgName: string
  scheme: PreviewScheme
}): ReactNode {
  const logo = scheme === 'dark' ? (branding.logoDarkUrl ?? branding.logoUrl) : branding.logoUrl
  return (
    <div {...stylex.props(styles.brand)}>
      {logo ? (
        <img src={logo} alt="" {...stylex.props(styles.logo)} />
      ) : (
        <span aria-hidden="true" {...stylex.props(styles.brandTile)}>
          {initialOf(orgName)}
        </span>
      )}
      <span {...stylex.props(styles.brandName)}>{orgName}</span>
    </div>
  )
}

type PreviewColors = {
  button: CSSProperties
  link: CSSProperties
  context: CSSProperties
}

// 浅色按钮用原始强调色加白字(发布校验的对象);深色、链接与浅底按 Hosted UI 的派生结果。
function previewColors(branding: OrgBranding, scheme: PreviewScheme): PreviewColors {
  const accent = brandAccentOf(branding)
  const palette = accent ? deriveAccentPalette(accent, scheme) : null
  if (!accent || !palette) {
    return {
      button: { backgroundColor: tokens['--xid-accent'], color: tokens['--xid-accent-foreground'] },
      link: { color: tokens['--xid-accent'] },
      context: { backgroundColor: tokens['--xid-accent-wash'] },
    }
  }
  return {
    button:
      scheme === 'light'
        ? { backgroundColor: accent, color: tokens['--xid-accent-foreground'] }
        : { backgroundColor: palette.accent, color: palette.accentForeground },
    link: { color: palette.accent },
    context: { backgroundColor: palette.accentWash },
  }
}

export type BrandPreviewProps = {
  branding: OrgBranding
  orgName: string
  host: string
  scheme: PreviewScheme
}

export function BrandPreview({ branding, orgName, host, scheme }: BrandPreviewProps): ReactNode {
  const { t } = useLingui()
  const colors = previewColors(branding, scheme)
  const radius: CSSProperties = {
    borderRadius: BRAND_RADIUS_CSS[branding.borderRadius ?? 'medium'],
  }
  return (
    <div {...stylex.props(styles.frame)} role="img" aria-label={t`Sign-in page preview`}>
      <div {...stylex.props(styles.addressBar)}>
        <span {...stylex.props(styles.address)}>{`${host}/sign-in`}</span>
      </div>
      <div
        {...stylex.props(scheme === 'dark' ? darkTheme : lightTheme, styles.page)}
        aria-hidden="true"
      >
        <div {...stylex.props(styles.context)} style={colors.context}>
          <BrandMark branding={branding} orgName={orgName} scheme={scheme} />
          <span {...stylex.props(styles.contextShort)}>
            <Trans>Continuing to your app</Trans>
          </span>
          <div {...stylex.props(styles.contextBody)}>
            <p {...stylex.props(styles.muted)}>
              <Trans>You are signing in to continue to</Trans>
            </p>
            <p {...stylex.props(styles.appName)}>
              <Trans>Your app</Trans>
            </p>
            <p {...stylex.props(styles.muted)}>
              <Trans>Your app will receive your name and email address.</Trans>
            </p>
          </div>
          <div {...stylex.props(styles.contextFooter)}>
            <span>
              <Trans>Secured by XID</Trans>
            </span>
            <span>
              <Trans>English</Trans>
            </span>
          </div>
        </div>
        <div {...stylex.props(styles.form)}>
          <div>
            <p {...stylex.props(styles.heading)}>
              <Trans>Sign in to {orgName}</Trans>
            </p>
            <div {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.muted)}>
                <Trans>New to {orgName}?</Trans>
              </span>
              <span style={colors.link}>
                <Trans>Create account</Trans>
              </span>
            </div>
          </div>
          <div>
            <span {...stylex.props(styles.label)}>
              <Trans>Email</Trans>
            </span>
            <div {...stylex.props(styles.field)} style={radius}>
              <Trans>you@example.com</Trans>
            </div>
          </div>
          <div {...stylex.props(styles.button)} style={{ ...colors.button, ...radius }}>
            <Trans>Continue</Trans>
          </div>
          <div {...stylex.props(styles.divider)}>
            <span {...stylex.props(styles.rule)} />
            <Trans>or</Trans>
            <span {...stylex.props(styles.rule)} />
          </div>
          <div {...stylex.props(styles.button, styles.secondaryButton)} style={radius}>
            <Trans>Continue with Google</Trans>
          </div>
          <div {...stylex.props(styles.footerLinks)}>
            <span>
              <Trans>Use single sign-on</Trans>
            </span>
            <span>
              <Trans>Can&apos;t sign in?</Trans>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
