// /sign-up -> /sign-in 仅透传认证动线 query 白名单。

export type SignUpRedirectSearch = {
  continue?: string
  locale?: string
  redirect?: string
  invitation_token?: string
  client_id?: string
  organization_id?: string
  authz_request_id?: string
}

export type SignUpRedirectTarget = {
  intent: 'sign-up'
  continue?: string
  locale?: string
  invitation_token?: string
  client_id?: string
  organization_id?: string
  authz_request_id?: string
}

export function signUpRedirectSearch(search: SignUpRedirectSearch): SignUpRedirectTarget {
  const targetSearch: SignUpRedirectTarget = {
    intent: 'sign-up',
  }
  const continueTo = search.continue ?? search.redirect
  if (continueTo) targetSearch.continue = continueTo
  if (search.locale) targetSearch.locale = search.locale
  if (search.invitation_token) targetSearch.invitation_token = search.invitation_token
  if (search.client_id) targetSearch.client_id = search.client_id
  if (search.organization_id) targetSearch.organization_id = search.organization_id
  if (search.authz_request_id) targetSearch.authz_request_id = search.authz_request_id
  return targetSearch
}
