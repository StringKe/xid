export const PRODUCT_SIGN_UP_INTENT = 'sign-up'
export const APPLICATION_SIGN_UP_INTENT = 'application-sign-up'

export type HostedAuthIntent =
  | 'sign-in'
  | typeof PRODUCT_SIGN_UP_INTENT
  | typeof APPLICATION_SIGN_UP_INTENT

export function isHostedAuthIntent(value: string | null | undefined): value is HostedAuthIntent {
  return (
    value === 'sign-in' || value === PRODUCT_SIGN_UP_INTENT || value === APPLICATION_SIGN_UP_INTENT
  )
}

export function isSignUpIntent(
  value: string | null | undefined,
): value is typeof PRODUCT_SIGN_UP_INTENT | typeof APPLICATION_SIGN_UP_INTENT {
  return value === PRODUCT_SIGN_UP_INTENT || value === APPLICATION_SIGN_UP_INTENT
}

export function isProductSignUpIntent(
  value: string | null | undefined,
): value is typeof PRODUCT_SIGN_UP_INTENT {
  return value === PRODUCT_SIGN_UP_INTENT
}

export function isApplicationSignUpIntent(
  value: string | null | undefined,
): value is typeof APPLICATION_SIGN_UP_INTENT {
  return value === APPLICATION_SIGN_UP_INTENT
}
