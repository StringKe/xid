import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from '../../components/ui'
import { styles } from './styles'
import type { PublicSocialProvider } from './auth-config'

export type SocialProvider = 'google' | 'github' | 'microsoft' | 'apple'

export type SignInSocialButtonsProps = {
  providers: readonly PublicSocialProvider[]
  onSelect: (provider: string) => void
  isLoading: boolean
}

function GoogleIcon(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

function GitHubIcon(): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function MicrosoftIcon(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M11.4 24H0V12.6h11.4V24z" fill="#F25022" />
      <path d="M24 24H12.6V12.6H24V24z" fill="#00A4EF" />
      <path d="M11.4 11.4H0V0h11.4v11.4z" fill="#7FBA00" />
      <path d="M24 11.4H12.6V0H24v11.4z" fill="#FFB900" />
    </svg>
  )
}

function AppleIcon(): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  )
}

type ProviderConfig = {
  id: string
  label: ReactNode
  icon: ReactNode
}

function providerIcon(id: string): ReactNode {
  if (id === 'google') return <GoogleIcon />
  if (id === 'github') return <GitHubIcon />
  if (id === 'microsoft') return <MicrosoftIcon />
  if (id === 'apple') return <AppleIcon />
  return null
}

function providerLabel(provider: string): ReactNode {
  if (provider === 'google') return <Trans>Continue with Google</Trans>
  if (provider === 'github') return <Trans>Continue with GitHub</Trans>
  if (provider === 'microsoft') return <Trans>Continue with Microsoft</Trans>
  if (provider === 'apple') return <Trans>Continue with Apple</Trans>
  return provider
}

function useProviders(providers: readonly PublicSocialProvider[]): readonly ProviderConfig[] {
  return providers.map((provider) => ({
    id: provider.provider,
    label: providerLabel(provider.provider),
    icon: providerIcon(provider.provider),
  }))
}

export function SignInSocialButtons({
  providers,
  onSelect,
  isLoading,
}: SignInSocialButtonsProps): ReactNode {
  const visibleProviders = useProviders(providers)

  if (visibleProviders.length === 0) return null

  return (
    <div {...stylex.props(styles.socialStack)}>
      {visibleProviders.map((p) => (
        <Button
          key={p.id}
          variant="secondary"
          fullWidth
          disabled={isLoading}
          onClick={() => onSelect(p.id)}
          {...stylex.props(styles.socialButton)}
        >
          {p.icon}
          {p.label}
        </Button>
      ))}
    </div>
  )
}
