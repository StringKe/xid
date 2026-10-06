// 响应式 props:标量或按视口档位的对象,移动优先逐档继承。档位与 scale.stylex.ts 的 media 一致。

export const VIEWPORTS = ['narrow', 'regular', 'sidebar', 'wide'] as const
export type Viewport = (typeof VIEWPORTS)[number]

export const BREAKPOINTS = { regular: '48rem', sidebar: '64rem', wide: '90rem' } as const

type Scalar = string | number | boolean

export type Responsive<T extends Scalar> = T | Partial<Record<Viewport, T>>

export type ResolvedResponsive<T extends Scalar> = Record<Viewport, T>

function isViewportMap<T extends Scalar>(
  value: Responsive<T>,
): value is Partial<Record<Viewport, T>> {
  return typeof value === 'object' && value !== null
}

export function resolveResponsive<T extends Scalar>(
  value: Responsive<T> | undefined,
  fallback: T,
): ResolvedResponsive<T> {
  if (value === undefined)
    return { narrow: fallback, regular: fallback, sidebar: fallback, wide: fallback }
  if (!isViewportMap(value)) return { narrow: value, regular: value, sidebar: value, wide: value }
  const narrow = value.narrow ?? fallback
  const regular = value.regular ?? narrow
  const sidebar = value.sidebar ?? regular
  const wide = value.wide ?? sidebar
  return { narrow, regular, sidebar, wide }
}

export function viewportMediaQuery(viewport: Viewport): string {
  if (viewport === 'narrow') return `(max-width: calc(${BREAKPOINTS.regular} - 0.01rem))`
  return `(min-width: ${BREAKPOINTS[viewport]})`
}
