import { ICON_FRAME, ICON_GLYPHS, type IconName } from '@xid-kit/web-ui/icon-glyphs'

// ICON_FRAME 用 React 的 camelCase 属性名；SVG 里只有 stroke-* 是连字符写法，viewBox 保持原样。
function attributes(values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values)
    .map(([name, value]) => {
      const attribute = name.startsWith('stroke')
        ? name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
        : name
      return `${attribute}="${value}"`
    })
    .join(' ')
}

// 产品端 Icon.tsx 与网站读同一份字形数据；网站没有 React 运行时，在构建期或脚本里拼成 SVG 字符串。
export function iconSvg(name: IconName, size: number): string {
  const shapes = ICON_GLYPHS[name].map(([tag, shape]) => `<${tag} ${attributes(shape)} />`).join('')
  const frame = attributes({ ...ICON_FRAME, width: size, height: size })
  return `<svg xmlns="http://www.w3.org/2000/svg" ${frame} aria-hidden="true" focusable="false">${shapes}</svg>`
}
