import {
  useLocation as useTanstackLocation,
  useNavigate as useTanstackNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { mergeClassNames } from './class-name'
import { createRouterAdapter } from './router'
import type { NavigateFunction, NavigationRuntime, RouterAdapter } from './router'

const NavigationRuntimeContext = createContext<NavigationRuntime>('core')

export type NavigationRuntimeProviderProps = {
  children: ReactNode
  runtime: NavigationRuntime
}

export function NavigationRuntimeProvider({
  children,
  runtime,
}: NavigationRuntimeProviderProps): ReactNode {
  return <NavigationRuntimeContext value={runtime}>{children}</NavigationRuntimeContext>
}

function useRouterAdapter(): RouterAdapter {
  const runtime = useContext(NavigationRuntimeContext)
  const location = useTanstackLocation()
  const navigate = useTanstackNavigate()
  return useMemo(
    () =>
      createRouterAdapter({
        runtime,
        getCurrentPathname: () => location.pathname,
        clientNavigate: (to, options) =>
          navigate({ href: to, replace: options?.replace, state: options?.state as never }),
      }),
    [location.pathname, navigate, runtime],
  )
}

export function useNavigate(): NavigateFunction {
  return useRouterAdapter().navigate
}

export function useSearchParams(): readonly [URLSearchParams] {
  const searchStr = useRouterState({
    select: (state) => state.location.searchStr,
  })
  const params = useMemo(() => new URLSearchParams(searchStr), [searchStr])
  return [params] as const
}

export type Location = {
  pathname: string
  search: string
  hash: string
  state: unknown
}

export function useLocation(): Location {
  const location = useTanstackLocation()
  return {
    pathname: location.pathname,
    search: location.searchStr,
    hash: location.hash ? `#${location.hash}` : '',
    state: location.state,
  }
}

export type RouterTo = string | { pathname?: string; search?: string; hash?: string }

function normalizeTo(to: RouterTo): string {
  if (typeof to === 'string') return to
  const pathname = to.pathname ?? ''
  const search = to.search ? (to.search.startsWith('?') ? to.search : `?${to.search}`) : ''
  const hash = to.hash ? (to.hash.startsWith('#') ? to.hash : `#${to.hash}`) : ''
  return `${pathname}${search}${hash}`
}

function pathnameFromHref(href: string, currentPathname: string): string {
  if (href.startsWith('?') || href.startsWith('#')) return currentPathname
  const path = href.split(/[?#]/, 1)[0] ?? ''
  return path === '' ? currentPathname : path
}

function isActivePath(currentPathname: string, href: string, end?: boolean): boolean {
  const pathname = pathnameFromHref(href, currentPathname)
  if (end) return currentPathname === pathname
  return currentPathname === pathname || currentPathname.startsWith(`${pathname}/`)
}

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: RouterTo
  replace?: boolean
  children?: ReactNode
}

function shouldHandleClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  target: AnchorHTMLAttributes<HTMLAnchorElement>['target'],
  download: AnchorHTMLAttributes<HTMLAnchorElement>['download'],
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !target &&
    !download &&
    (href.startsWith('/') || href.startsWith('?') || href.startsWith('#'))
  )
}

export function Link({
  to,
  replace,
  children,
  onClick,
  target,
  download,
  ...rest
}: LinkProps): ReactNode {
  const href = normalizeTo(to)
  const adapter = useRouterAdapter()
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (!shouldHandleClick(event, href, target, download)) return
      if (adapter.usesDocumentNavigation(href) && !replace) return
      event.preventDefault()
      adapter.navigate(href, { replace })
    },
    [adapter, download, href, onClick, replace, target],
  )

  return (
    <a href={href} target={target} download={download} onClick={handleClick} {...rest}>
      {children}
    </a>
  )
}

export type NavLinkRenderState = { isActive: boolean }

export type NavLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'className' | 'children'
> & {
  to: RouterTo
  end?: boolean
  className?: string | ((state: NavLinkRenderState) => string)
  children?: ReactNode | ((state: NavLinkRenderState) => ReactNode)
}

export function NavLink({
  to,
  end,
  className,
  children,
  onClick,
  target,
  download,
  ...rest
}: NavLinkProps): ReactNode {
  const href = normalizeTo(to)
  const location = useLocation()
  const adapter = useRouterAdapter()
  const state: NavLinkRenderState = { isActive: isActivePath(location.pathname, href, end) }
  const resolvedClassName = typeof className === 'function' ? className(state) : className
  const resolvedChildren = typeof children === 'function' ? children(state) : children
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (!shouldHandleClick(event, href, target, download)) return
      if (adapter.usesDocumentNavigation(href)) return
      event.preventDefault()
      adapter.navigate(href)
    },
    [adapter, download, href, onClick, target],
  )

  return (
    <a
      href={href}
      target={target}
      download={download}
      {...rest}
      onClick={handleClick}
      className={mergeClassNames(resolvedClassName)}
    >
      {resolvedChildren}
    </a>
  )
}

export type NavigateComponentProps = {
  to: string
  replace?: boolean
  state?: unknown
}

export function Navigate({ to, replace, state }: NavigateComponentProps): ReactNode {
  const adapter = useRouterAdapter()
  const location = useTanstackLocation()
  const previousRef = useRef<NavigateComponentProps | null>(null)

  useEffect(() => {
    if (location.href === to) return
    const previous = previousRef.current
    if (previous?.to === to && previous.replace === replace && Object.is(previous.state, state)) {
      return
    }
    previousRef.current = { to, replace, state }
    adapter.navigate(to, { replace, state })
  }, [adapter, location.href, replace, state, to])
  return null
}
