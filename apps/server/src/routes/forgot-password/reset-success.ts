import { trackPasswordResetComplete } from '../../lib/google-analytics-funnel'

export type ResetSuccessDeps = {
  refresh: () => Promise<void>
  navigate: (options: { to: string; replace: boolean }) => Promise<unknown>
  redirectUrl?: string
  fallbackPath: string
}

export async function handleResetPasswordSuccess(deps: ResetSuccessDeps): Promise<void> {
  trackPasswordResetComplete()
  await deps.refresh()
  await deps.navigate({ to: deps.redirectUrl ?? deps.fallbackPath, replace: true })
}
