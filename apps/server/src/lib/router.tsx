// react-router 兼容层(backed by @tanstack/react-router)。
// 目的:页面/布局以最小改动从 react-router 迁移到 TanStack Router,调用点签名保持一致。
// 这里把 TanStack 的强类型 to(按路由树校验)放宽为运行时 string,现有页面用动态字符串路径
// (nav 数组、redirectUrl、continue 回跳),不适合逐路由静态 to;类型安全由 root validateSearch
// passthrough + 应用层 open-redirect 校验(见 useSignIn.resolveRedirect)保证。
// 新页面若要 TanStack 全类型路由(Route.useSearch / typed Link),直接用 @tanstack/react-router,
// 不必经此兼容层(样板见 routes/verify-email)。

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import {
  useLocation as useTanstackLocation,
  useNavigate as useTanstackNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { mergeClassNames } from './class-name'

// react-router 的 navigate(path, { replace, state }):path 为任意 string。
export type NavigateOptions = {
  replace?: boolean
  state?: unknown
}

export type NavigateFunction = (to: string, options?: NavigateOptions) => void

// useNavigate:返回与 react-router 同形的命令式导航函数。
// 透传任意 string 路径(含 query/hash);TanStack 内部按 history 解析。
export function useNavigate(): NavigateFunction {
  const navigate = useTanstackNavigate()
  return useCallback(
    (to, options) => {
      void navigate({ href: to, replace: options?.replace, state: options?.state as never })
    },
    [navigate],
  )
}

// useSearchParams:返回 [URLSearchParams] 元组(只读用法)。
// 现有页面只解构第一项做 params.get(key),故 setter 省略。
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

// useLocation:暴露 pathname/search/hash/state,对齐 react-router 的最常用字段。
export function useLocation(): Location {
  const loc = useTanstackLocation()
  return {
    pathname: loc.pathname,
    search: loc.searchStr,
    hash: loc.hash ? `#${loc.hash}` : '',
    state: loc.state,
  }
}

// react-router 的 to 支持 string 或 { pathname?, search?, hash? } 对象(mfa 用 { search } 改 query)。
export type RouterTo = string | { pathname?: string; search?: string; hash?: string }

// 把 react-router to 归一为单个 href 字符串;纯对象(仅 search)解析为相对当前路径的 href。
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

function shouldClientNavigate(
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

// Link:to(string 或对象)归一为真实 href,点击时接管内部 SPA 导航。
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
  const navigate = useTanstackNavigate()
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (!shouldClientNavigate(event, href, target, download)) return
      event.preventDefault()
      void navigate({ href, replace })
    },
    [download, href, navigate, onClick, replace, target],
  )

  return (
    <a href={href} target={target} download={download} onClick={handleClick} {...rest}>
      {children}
    </a>
  )
}

// NavLink:对齐 react-router NavLink 的 className/children 渲染函数签名(接收 { isActive })。
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
  const navigate = useTanstackNavigate()
  const state: NavLinkRenderState = { isActive: isActivePath(location.pathname, href, end) }
  const resolvedClassName = typeof className === 'function' ? className(state) : className
  const resolvedChildren = typeof children === 'function' ? children(state) : children
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (!shouldClientNavigate(event, href, target, download)) return
      event.preventDefault()
      void navigate({ href })
    },
    [download, href, navigate, onClick, target],
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

// Navigate:声明式重定向组件(对齐 react-router <Navigate to replace state />)。
export function Navigate({ to, replace, state }: NavigateComponentProps): ReactNode {
  const navigate = useTanstackNavigate()
  const location = useTanstackLocation()
  const previousRef = useRef<NavigateComponentProps | null>(null)

  useEffect(() => {
    if (location.href === to) return
    const previous = previousRef.current
    if (previous?.to === to && previous.replace === replace && Object.is(previous.state, state)) {
      return
    }
    previousRef.current = { to, replace, state }
    void navigate({ href: to, replace, state: state as never })
  }, [location.href, navigate, replace, state, to])
  return null
}
