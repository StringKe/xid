import { sha256Hex } from '@xid-kit/crypto'
import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackInvitationAccepted } from '../../lib/google-analytics-funnel'
import { tokens } from '../../styles/tokens.stylex'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { useTurnstile } from '../sign-in/useTurnstile'

type InvitationPreview = {
  status: 'pending' | 'expired' | 'invalid'
  email: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  expiresAt: string | null
}

type ClaimRecovery = {
  identifier: string
  recoveryKey: string
}

const CLAIM_STORAGE_PREFIX = 'xid.invitation-claim'
const CURRENT_CLAIM_IDENTIFIER_KEY = `${CLAIM_STORAGE_PREFIX}.current`

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  details: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  meta: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
    lineHeight: 1.55,
  },
  turnstile: {
    display: 'flex',
    justifyContent: 'center',
    width: '100%',
  },
})

function claimTokenStorageKey(identifier: string): string {
  return `${CLAIM_STORAGE_PREFIX}.${identifier}.token`
}

function recoveryStorageKey(identifier: string): string {
  return `${CLAIM_STORAGE_PREFIX}.${identifier}.recovery`
}

function getSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function readStoredClaimToken(): string | null {
  const storage = getSessionStorage()
  if (!storage) return null
  try {
    const identifier = storage.getItem(CURRENT_CLAIM_IDENTIFIER_KEY)
    if (!identifier || !/^[0-9a-f]{64}$/.test(identifier)) return null
    return storage.getItem(claimTokenStorageKey(identifier))
  } catch {
    return null
  }
}

async function rememberClaimToken(token: string): Promise<string> {
  const identifier = await sha256Hex(token)
  const storage = getSessionStorage()
  if (!storage) return identifier
  try {
    storage.setItem(claimTokenStorageKey(identifier), token)
    storage.setItem(CURRENT_CLAIM_IDENTIFIER_KEY, identifier)
  } catch {
    // The claim remains usable from component memory when browser storage is unavailable.
  }
  return identifier
}

function randomRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}

async function getOrCreateRecovery(
  token: string,
  current: ClaimRecovery | null,
): Promise<ClaimRecovery> {
  const identifier = await sha256Hex(token)
  if (current?.identifier === identifier) return current

  const storage = getSessionStorage()
  if (storage) {
    try {
      const stored = storage.getItem(recoveryStorageKey(identifier))
      if (stored && stored.length >= 32 && stored.length <= 256) {
        return { identifier, recoveryKey: stored }
      }
    } catch {
      // A fresh in-memory recovery key still keeps retries idempotent in this page instance.
    }
  }

  const recovery = { identifier, recoveryKey: randomRecoveryKey() }
  if (storage) {
    try {
      storage.setItem(recoveryStorageKey(identifier), recovery.recoveryKey)
    } catch {
      // The in-memory recovery key is sufficient until this page is closed.
    }
  }
  return recovery
}

function clearClaimStorage(identifier: string): void {
  const storage = getSessionStorage()
  if (!storage) return
  try {
    storage.removeItem(claimTokenStorageKey(identifier))
    storage.removeItem(recoveryStorageKey(identifier))
    if (storage.getItem(CURRENT_CLAIM_IDENTIFIER_KEY) === identifier) {
      storage.removeItem(CURRENT_CLAIM_IDENTIFIER_KEY)
    }
  } catch {
    // A successful response has already consumed the one-time server proof.
  }
}

function clearCurrentClaimStorage(): void {
  const storage = getSessionStorage()
  if (!storage) return
  try {
    const identifier = storage.getItem(CURRENT_CLAIM_IDENTIFIER_KEY)
    if (identifier && /^[0-9a-f]{64}$/.test(identifier)) {
      clearClaimStorage(identifier)
      return
    }
    storage.removeItem(CURRENT_CLAIM_IDENTIFIER_KEY)
  } catch {
    // A raw invitation remains usable even if stale session storage cannot be cleared.
  }
}

function claimTokenFromFragment(): string | null {
  const hash = globalThis.location.hash
  if (!hash.startsWith('#')) return null
  const token = new URLSearchParams(hash.slice(1)).get('claim_token')?.trim()
  return token || null
}

function scrubFragment(): void {
  globalThis.history.replaceState(
    globalThis.history.state,
    '',
    `${globalThis.location.pathname}${globalThis.location.search}`,
  )
}

export const invitationNavigation = {
  assign(redirectUrl: string): void {
    globalThis.location.assign(redirectUrl)
  },
}

export function AcceptInvitationPage(): ReactNode {
  const search = useSearch({ strict: false }) as { token?: string }
  const rawToken = search.token?.trim() || null
  const { api } = useAuth()
  const { t } = useLingui()
  const [fragmentReady, setFragmentReady] = useState(false)
  const [claimToken, setClaimToken] = useState<string | null>(
    () => claimTokenFromFragment() ?? (rawToken ? null : readStoredClaimToken()),
  )
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [claimStartPending, setClaimStartPending] = useState(false)
  const [claimStartComplete, setClaimStartComplete] = useState(false)
  const [claimStartError, setClaimStartError] = useState<string | null>(null)
  const [claimVerifyPending, setClaimVerifyPending] = useState(false)
  const [claimVerifyError, setClaimVerifyError] = useState<string | null>(null)
  const recoveryRef = useRef<ClaimRecovery | null>(null)

  useLayoutEffect(() => {
    const fragmentToken = claimTokenFromFragment()
    if (fragmentToken) {
      scrubFragment()
      setClaimToken(fragmentToken)
    } else if (rawToken) {
      clearCurrentClaimStorage()
      setClaimToken(null)
    }
    setFragmentReady(true)
  }, [rawToken])

  useEffect(() => {
    if (!claimToken) return
    void rememberClaimToken(claimToken)
  }, [claimToken])

  const preview = useQuery({
    queryKey: ['invitation-preview', rawToken],
    enabled: fragmentReady && claimToken === null && rawToken !== null,
    retry: false,
    queryFn: async (): Promise<InvitationPreview> => {
      const result = await api.get<InvitationPreview>(
        `/auth/invitation/preview?token=${encodeURIComponent(rawToken ?? '')}`,
      )
      if (!result.ok) throw result.error
      return result.value
    },
  })

  const previewData = preview.data
  const authConfigEnabled =
    claimToken === null &&
    rawToken !== null &&
    previewData?.status === 'pending' &&
    previewData.orgId !== null
  const authConfigQuery = useQuery<PublicHostedAuthConfig, never>({
    queryKey: ['auth-config', 'invitation-claim', previewData?.orgId ?? null],
    enabled: authConfigEnabled,
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams()
      if (previewData?.orgId) params.set('organization_id', previewData.orgId)
      const path = params.size > 0 ? `/auth/config?${params.toString()}` : '/auth/config'
      const result = await api.get<PublicHostedAuthConfig>(path)
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
  })
  const authConfig = authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG
  const { containerRef } = useTurnstile(
    authConfig.turnstileSiteKey,
    turnstileToken,
    setTurnstileToken,
  )

  async function handleClaimStart(): Promise<void> {
    if (!rawToken || claimStartPending) return
    setClaimStartPending(true)
    setClaimStartError(null)
    const result = await api.post<{ ok: true }>('/auth/invitation/claim', {
      token: rawToken,
      turnstileToken,
    })
    setClaimStartPending(false)
    setTurnstileToken(null)
    if (!result.ok) {
      setClaimStartError(t`We could not send the invitation email. Please try again.`)
      return
    }
    setClaimStartComplete(true)
  }

  async function handleClaimVerify(): Promise<void> {
    if (!claimToken || claimVerifyPending) return
    setClaimVerifyPending(true)
    setClaimVerifyError(null)
    const recovery = await getOrCreateRecovery(claimToken, recoveryRef.current)
    recoveryRef.current = recovery
    const result = await api.post<{ redirectUrl: string }>('/auth/invitation/claim/verify', {
      token: claimToken,
      recoveryKey: recovery.recoveryKey,
    })
    setClaimVerifyPending(false)
    if (!result.ok) {
      setClaimVerifyError(
        t`This email link is invalid or expired. Open the latest invitation email and try again.`,
      )
      return
    }
    clearClaimStorage(recovery.identifier)
    recoveryRef.current = null
    trackInvitationAccepted()
    invitationNavigation.assign(result.value.redirectUrl)
  }

  if (!fragmentReady) {
    return (
      <AuthLayout>
        <Spinner label={t`Loading invitation`} />
      </AuthLayout>
    )
  }

  if (claimToken) {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader
            title={<Trans>Confirm your invitation</Trans>}
            lead={
              <Trans>
                Continue only if you opened this link from the invitation email sent to you.
              </Trans>
            }
          />
          {claimVerifyError ? <Alert tone="error">{claimVerifyError}</Alert> : null}
          <Button
            type="button"
            fullWidth
            isLoading={claimVerifyPending}
            onClick={() => void handleClaimVerify()}
          >
            <Trans>Confirm and join</Trans>
          </Button>
        </div>
      </AuthLayout>
    )
  }

  if (!rawToken) {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader title={<Trans>Invitation unavailable</Trans>} />
          <Alert tone="error">
            <Trans>Invitation link is invalid.</Trans>
          </Alert>
        </div>
      </AuthLayout>
    )
  }

  if (preview.isPending) {
    return (
      <AuthLayout>
        <Spinner label={t`Loading invitation`} />
      </AuthLayout>
    )
  }

  const data = preview.data
  if (!data || data.status === 'invalid') {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader title={<Trans>Invitation unavailable</Trans>} />
          <Alert tone="error">
            <Trans>This invitation link is invalid or has already been used.</Trans>
          </Alert>
        </div>
      </AuthLayout>
    )
  }

  if (data.status === 'expired') {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader title={<Trans>Invitation expired</Trans>} />
          <Alert tone="warning">
            <Trans>Ask your organization admin to send a new invitation.</Trans>
          </Alert>
        </div>
      </AuthLayout>
    )
  }

  if (claimStartComplete) {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader
            title={<Trans>Check your email</Trans>}
            lead={
              <Trans>
                We sent a one-time invitation link to {data.email}. Open it in this browser to
                continue.
              </Trans>
            }
          />
        </div>
      </AuthLayout>
    )
  }

  const turnstileRequired = authConfig.turnstileSiteKey !== null
  const waitingForAuthConfig = authConfigEnabled && authConfigQuery.isPending
  const claimStartDisabled =
    claimStartPending || waitingForAuthConfig || (turnstileRequired && turnstileToken === null)

  return (
    <AuthLayout>
      <div {...stylex.props(styles.stack)}>
        <PageHeader
          title={
            data.orgName ? <Trans>Join {data.orgName}</Trans> : <Trans>Join organization</Trans>
          }
          lead={
            <Trans>
              We will verify {data.email} before creating your account and adding you to this
              organization.
            </Trans>
          }
        />
        <div {...stylex.props(styles.details)}>
          <p {...stylex.props(styles.meta)}>
            <Trans>Invited email: {data.email}</Trans>
          </p>
          {data.role ? (
            <p {...stylex.props(styles.meta)}>
              <Trans>Organization role: {data.role}</Trans>
            </p>
          ) : null}
        </div>
        {claimStartError ? <Alert tone="error">{claimStartError}</Alert> : null}
        <Button
          type="button"
          fullWidth
          isLoading={claimStartPending}
          disabled={claimStartDisabled}
          onClick={() => void handleClaimStart()}
        >
          <Trans>Email me a secure link</Trans>
        </Button>
        <div ref={containerRef} {...stylex.props(styles.turnstile)} />
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/accept-invitation')({
  component: AcceptInvitationPage,
})
