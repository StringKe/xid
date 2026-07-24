export type SignUpRedirectSearch = {
  continue?: string
  locale?: string
  redirect?: string
}

export function signUpRedirectSearch(search: SignUpRedirectSearch): {
  intent: 'sign-up'
  continue?: string
  locale?: string
} {
  const targetSearch: { intent: 'sign-up'; continue?: string; locale?: string } = {
    intent: 'sign-up',
  }
  const continueTo = search.continue ?? search.redirect
  if (continueTo) targetSearch.continue = continueTo
  if (search.locale) targetSearch.locale = search.locale
  return targetSearch
}
