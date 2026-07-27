export function signInRedirectTarget(pathname: string, search: string, hash: string): string {
  if (pathname === '/sign-in') return `${pathname}${search}${hash}`
  const returnTo = `${pathname}${search}${hash}`
  return `/sign-in?continue=${encodeURIComponent(returnTo)}`
}
