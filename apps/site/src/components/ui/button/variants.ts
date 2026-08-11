// Button 与 LinkButton 共用样式源，避免两套视觉漂移。
import { cn } from '@/lib/cn'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'secondary-destructive'
  | 'outline'
export type ButtonSize = 'xs' | 'sm' | 'base' | 'lg'
export type ButtonShape = 'base' | 'square' | 'circle'

export const buttonBase =
  'group inline-flex w-max shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap no-underline transition-all cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export const buttonVariantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover hover:shadow',
  secondary:
    'bg-card text-foreground ring ring-border shadow-sm hover:bg-accent hover:ring-border-strong',
  ghost: 'bg-transparent text-foreground shadow-none hover:bg-accent',
  destructive: 'bg-danger text-white shadow-sm hover:bg-danger/90',
  'secondary-destructive':
    'bg-card text-danger ring ring-border shadow-sm hover:bg-accent hover:ring-danger/40',
  outline: 'bg-transparent text-foreground ring ring-border hover:ring-border-strong',
}

export const buttonSizeText: Record<ButtonSize, string> = {
  xs: 'gap-1 px-2 py-1 text-xs',
  sm: 'gap-1 px-3 py-1.5 text-xs',
  base: 'gap-1.5 px-4 py-2 text-sm',
  lg: 'gap-2 px-5 py-2.5 text-sm',
}

export const buttonSizeCompact: Record<ButtonSize, string> = {
  xs: 'size-7',
  sm: 'size-8',
  base: 'size-9',
  lg: 'size-10',
}

export const buttonIconSize: Record<ButtonSize, string> = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-3.5 w-3.5',
  base: 'h-4 w-4',
  lg: 'h-[1.125rem] w-[1.125rem]',
}

export interface ButtonVariantsOptions {
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
}

export function buttonVariants({
  variant = 'secondary',
  size = 'base',
  shape = 'base',
}: ButtonVariantsOptions = {}): string {
  // circle 覆盖 buttonBase 的 rounded-lg 为 full pill。
  const dims =
    shape === 'base'
      ? buttonSizeText[size]
      : cn(buttonSizeCompact[size], 'p-0', shape === 'circle' && 'rounded-full')
  return cn(buttonBase, buttonVariantClasses[variant], dims)
}
