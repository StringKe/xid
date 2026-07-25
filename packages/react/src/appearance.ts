// appearance prop:CSS 变量覆盖 + className 覆盖主题系统(对标 Clerk appearance prop)。
// 仅传 CSS 自定义属性名前缀为 --xid-,组件用 style 注入,不含任何样式值硬编码。

export type AppearanceVariables = {
  // 品牌色
  colorPrimary?: string
  colorDanger?: string
  colorSuccess?: string
  colorWarning?: string
  colorBackground?: string
  colorText?: string
  colorTextSecondary?: string
  // 圆角
  borderRadius?: string
  // 字体
  fontFamily?: string
  fontSize?: string
  // 阴影
  boxShadow?: string
}

export type AppearanceElements = {
  // 容器
  card?: string
  cardHeader?: string
  cardFooter?: string
  // 表单
  formField?: string
  formLabel?: string
  formInput?: string
  formButton?: string
  formError?: string
  // 按钮
  button?: string
  buttonPrimary?: string
  buttonSecondary?: string
  buttonDanger?: string
  // 用户
  userButtonTrigger?: string
  userButtonPopover?: string
  userAvatar?: string
  // 组织
  organizationSwitcherTrigger?: string
  organizationSwitcherPopover?: string
}

export type Appearance = {
  // CSS 变量覆盖(注入到根容器 style)
  variables?: AppearanceVariables
  // element className 覆盖(合并到组件 className)
  elements?: AppearanceElements
}

// 将 AppearanceVariables 转换为 CSS 变量 style 对象。
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

// 合并 element className:组件内置 class + 外部覆盖 class。
export function cx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}
