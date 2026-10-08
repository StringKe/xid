// Button 与 LinkButton 共用样式源，规格同产品 components/ui/Button.tsx。
import { cn } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'lg'
export type ButtonShape = 'base' | 'square'

const buttonBase =
  'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-base font-medium leading-[1.125rem] no-underline transition-[background-color,color,transform] duration-[120ms] ease-out active:scale-[0.97] aria-disabled:pointer-events-none aria-disabled:opacity-55'

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/84',
  accent: 'bg-accent text-accent-foreground hover:bg-accent-strong',
  secondary:
    'bg-card text-foreground shadow-[inset_0_0_0_1px_var(--xid-border-strong)] hover:bg-muted',
  ghost: 'bg-transparent text-foreground hover:bg-muted',
  danger: 'bg-danger text-danger-foreground hover:bg-danger/90',
}

const sizeClasses: Record<ButtonSize, Record<ButtonShape, string>> = {
  md: {
    base: 'h-9 px-3.5 pointer-coarse:h-11',
    square: 'size-9 pointer-coarse:size-11',
  },
  lg: {
    base: 'h-11 px-4',
    square: 'size-11',
  },
}

export type ButtonVariantsOptions = {
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
}

export function buttonVariants({
  variant = 'primary',
  size = 'md',
  shape = 'base',
}: ButtonVariantsOptions = {}): string {
  return cn(
    buttonBase,
    variantClasses[variant],
    sizeClasses[size][shape],
    variant === 'ghost' && shape === 'base' && 'px-3',
  )
}
