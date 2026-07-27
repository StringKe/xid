export const WEB_ROUTE_OWNER_HEADER = 'x-xid-route-owner'

export function webRouteOwnerMatches(headers, expectedOwner) {
  const actualOwner = headers.get(WEB_ROUTE_OWNER_HEADER)
  if (expectedOwner === 'core') {
    return actualOwner === null || actualOwner === 'core'
  }
  return actualOwner === expectedOwner
}

export function webRedirectLocationMatches(location, origin, pathname, search = '') {
  if (!location) return false
  let target
  try {
    target = new URL(location, origin)
  } catch {
    return false
  }
  return (
    target.origin === new URL(origin).origin &&
    target.pathname === pathname &&
    target.search === search
  )
}
