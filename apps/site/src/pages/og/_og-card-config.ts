// 构建期 OG 卡共享样式；文件名前置 _ 让 Astro 跳过路由（虽放在 pages/ 旁）。
// Geist 没有 CJK 字形，zh-hans / ja / ko 页面追加对应 Noto Sans 作回退；体积约 2.5MB/字重，按 astro-og-canvas 默认字体的方式从 Fontsource 取 TTF，构建期缓存，不入库。
// Fontsource 子集 TTF 的 name 表族名带 Thin 后缀(CanvasKit 按此解析),字重仍按文件区分。

import type { OGImageOptions } from 'astro-og-canvas'

const GEIST_FONTS = ['./public/fonts/Geist-SemiBold.ttf', './public/fonts/Geist-Regular.ttf']

const CJK_FALLBACKS: Record<string, { family: string; font: string; subset: string }> = {
  'zh-hans': { family: 'Noto Sans SC Thin', font: 'noto-sans-sc', subset: 'chinese-simplified' },
  ja: { family: 'Noto Sans JP Thin', font: 'noto-sans-jp', subset: 'japanese' },
  ko: { family: 'Noto Sans KR Thin', font: 'noto-sans-kr', subset: 'korean' },
}

function fontsourceTtf(font: string, subset: string, weight: number): string {
  return `https://api.fontsource.org/v1/fonts/${font}/${subset}-${weight}-normal.ttf`
}

export function ogCardConfig(path: string) {
  const fallback = CJK_FALLBACKS[path.split('/')[0] ?? '']
  const families = fallback ? ['Geist', fallback.family] : ['Geist']
  const fonts = fallback
    ? [
        ...GEIST_FONTS,
        fontsourceTtf(fallback.font, fallback.subset, 600),
        fontsourceTtf(fallback.font, fallback.subset, 400),
      ]
    : GEIST_FONTS
  return {
    bgGradient: [
      [11, 11, 12],
      [26, 26, 28],
    ],
    border: { color: [39, 39, 42], width: 2, side: 'inline-start' },
    padding: 96,
    fonts,
    font: {
      title: {
        color: [250, 250, 250],
        size: 64,
        weight: 'SemiBold',
        families,
        lineHeight: 1.1,
      },
      description: {
        color: [161, 161, 170],
        size: 32,
        weight: 'Normal',
        families,
        lineHeight: 1.3,
      },
    },
    format: 'PNG',
  } satisfies Partial<OGImageOptions>
}
