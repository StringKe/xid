// 构建期 OG 卡共享样式；文件名前置 _ 让 Astro 跳过路由（虽放在 pages/ 旁）。

import type { OGImageOptions } from 'astro-og-canvas'

export const ogCardConfig = {
  bgGradient: [
    [11, 11, 12],
    [26, 26, 28],
  ],
  border: { color: [39, 39, 42], width: 2, side: 'inline-start' },
  padding: 96,
  fonts: ['./public/fonts/Inter-Bold.ttf'],
  font: {
    title: {
      color: [250, 250, 250],
      size: 64,
      weight: 'Bold',
      families: ['Inter'],
      lineHeight: 1.1,
    },
    description: {
      color: [161, 161, 170],
      size: 32,
      weight: 'Bold',
      families: ['Inter'],
      lineHeight: 1.3,
    },
  },
  format: 'PNG',
} satisfies Partial<OGImageOptions>
