type PasswordRecoveryNavigationContext = {
  organizationId?: string | null
  locale?: string | null
}

function pathWithRecoveryContext(
  pathname: '/forgot-password' | '/sign-in',
  context: PasswordRecoveryNavigationContext,
): string {
  const params = new URLSearchParams()
  if (context.organizationId) params.set('organization_id', context.organizationId)
  if (context.locale) params.set('locale', context.locale)
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function forgotPasswordHref(context: PasswordRecoveryNavigationContext): string {
  return pathWithRecoveryContext('/forgot-password', context)
}

export function passwordRecoverySignInHref(context: PasswordRecoveryNavigationContext): string {
  return pathWithRecoveryContext('/sign-in', context)
}
