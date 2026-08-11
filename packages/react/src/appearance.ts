// 主题只注入 --xid-* CSS 变量与 element className,组件不硬编码样式值。

export type AppearanceVariables = {
  colorPrimary?: string
  colorDanger?: string
  colorSuccess?: string
  colorWarning?: string
  colorBackground?: string
  colorText?: string
  colorTextSecondary?: string
  borderRadius?: string
  fontFamily?: string
  fontSize?: string
  boxShadow?: string
}

export type AppearanceElements = {
  card?: string
  cardHeader?: string
  cardFooter?: string
  formField?: string
  formLabel?: string
  formInput?: string
  formButton?: string
  formError?: string
  button?: string
  buttonPrimary?: string
  buttonSecondary?: string
  buttonDanger?: string
  userButtonTrigger?: string
  userButtonPopover?: string
  userAvatar?: string
  organizationSwitcherTrigger?: string
  organizationSwitcherPopover?: string
}

export type Appearance = {
  variables?: AppearanceVariables
  elements?: AppearanceElements
}

export function buildCssVariables(
  variables: AppearanceVariables | undefined,
): Record<string, string> {
  if (!variables) return {}
  const style: Record<string, string> = {}
  const map: Record<keyof AppearanceVariables, string> = {
    colorPrimary: '--xid-color-primary',
    colorDanger: '--xid-color-danger',
    colorSuccess: '--xid-color-success',
    colorWarning: '--xid-color-warning',
    colorBackground: '--xid-color-background',
    colorText: '--xid-color-text',
    colorTextSecondary: '--xid-color-text-secondary',
    borderRadius: '--xid-border-radius',
    fontFamily: '--xid-font-family',
    fontSize: '--xid-font-size',
    boxShadow: '--xid-box-shadow',
  }
  for (const [key, cssVar] of Object.entries(map) as [keyof AppearanceVariables, string][]) {
    const val = variables[key]
    if (val !== undefined) style[cssVar] = val
  }
  return style
}

export function cx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}
