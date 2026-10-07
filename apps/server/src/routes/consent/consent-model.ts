// /auth/consent-params 的响应与再次授权时的新增 scope 计算。

export type AuthorizationDetail = {
  type: 'resource_access'
  locations: readonly string[]
  actions: readonly string[]
}

export type ConsentParams = {
  clientId: string
  clientName: string
  clientLogoUrl: string | null
  ownerOrganizationName: string | null
  redirectOrigin: string | null
  scopes: readonly { name: string }[]
  previouslyGrantedScopes: readonly string[]
  authorizationDetails: readonly AuthorizationDetail[]
  firstParty: boolean
}

export type ConsentScopes = {
  requested: readonly string[]
  added: readonly string[]
  alreadyAllowed: readonly string[]
  isReconsent: boolean
}

// 再次授权只列这次新增的 scope;之前同意过的合并成一行,不再逐项询问。
export function splitConsentScopes(
  params: Pick<ConsentParams, 'scopes' | 'previouslyGrantedScopes'>,
): ConsentScopes {
  const requested = params.scopes.map((scope) => scope.name)
  const granted = new Set(params.previouslyGrantedScopes)
  const added = requested.filter((scope) => !granted.has(scope))
  const alreadyAllowed = requested.filter((scope) => granted.has(scope))
  return { requested, added, alreadyAllowed, isReconsent: alreadyAllowed.length > 0 }
}
