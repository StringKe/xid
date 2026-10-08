// 构建期 OG 卡共享样式；文件名前置 _ 让 Astro 跳过路由（虽放在 pages/ 旁）。
// Geist 没有 CJK 字形，zh-hans / ja / ko 页面追加对应 Noto Sans 作回退；体积约 2.5MB/字重，构建期从 Fontsource 下载到 .astro/og-fonts，不入库。
// astro-og-canvas 对远程字体的非 2xx 只记日志并继续出图（字形变方块），所以这里先下载到本地，失败即中断构建。
// Fontsource 子集 TTF 的 name 表族名带 Thin 后缀(CanvasKit 按此解析),字重仍按文件区分。

import { mkdir, stat, writeFile } from 'node:fs/promises'
import type { OGImageOptions } from 'astro-og-canvas'

const GEIST_FONTS = ['./public/fonts/Geist-SemiBold.ttf', './public/fonts/Geist-Regular.ttf']
const FONT_CACHE_DIR = './.astro/og-fonts'
const FONT_DOWNLOAD_TIMEOUT_MS = 60_000

const CJK_FALLBACKS: Record<string, { family: string; font: string; subset: string }> = {
  'zh-hans': { family: 'Noto Sans SC Thin', font: 'noto-sans-sc', subset: 'chinese-simplified' },
  ja: { family: 'Noto Sans JP Thin', font: 'noto-sans-jp', subset: 'japanese' },
  ko: { family: 'Noto Sans KR Thin', font: 'noto-sans-kr', subset: 'korean' },
}

const CJK_WEIGHTS = [600, 400] as const

async function cachedFontsourceTtf(font: string, subset: string, weight: number): Promise<string> {
  const path = `${FONT_CACHE_DIR}/${font}-${subset}-${weight}.ttf`
  const cached = await stat(path).catch(() => null)
  if (cached?.isFile() && cached.size > 0) return path
  const url = `https://api.fontsource.org/v1/fonts/${font}/${subset}-${weight}-normal.ttf`
  const response = await fetch(url, { signal: AbortSignal.timeout(FONT_DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok)
    throw new Error(`OG font download failed: ${response.status} ${response.statusText} ${url}`)
  await mkdir(FONT_CACHE_DIR, { recursive: true })
  await writeFile(path, new Uint8Array(await response.arrayBuffer()))
  return path
}

const CJK_FONT_FILES = Object.fromEntries(
  await Promise.all(
    Object.entries(CJK_FALLBACKS).map(async ([locale, fallback]) => [
      locale,
      await Promise.all(
        CJK_WEIGHTS.map((weight) => cachedFontsourceTtf(fallback.font, fallback.subset, weight)),
      ),
    ]),
  ),
) as Record<string, string[]>

export function ogCardConfig(path: string) {
  const locale = path.split('/')[0] ?? ''
  const fallback = CJK_FALLBACKS[locale]
  const families = fallback ? ['Geist', fallback.family] : ['Geist']
  const fonts = fallback ? [...GEIST_FONTS, ...(CJK_FONT_FILES[locale] ?? [])] : GEIST_FONTS
  return {
    bgGradient: [[24, 24, 24]],
    border: { color: [42, 42, 42], width: 2, side: 'inline-start' },
    padding: 96,
    fonts,
    font: {
      title: {
        color: [237, 237, 237],
        size: 64,
        weight: 'SemiBold',
        families,
        lineHeight: 1.1,
      },
      description: {
        color: [163, 163, 163],
        size: 32,
        weight: 'Normal',
        families,
        lineHeight: 1.3,
      },
    },
    format: 'PNG',
  } satisfies Partial<OGImageOptions>
}
