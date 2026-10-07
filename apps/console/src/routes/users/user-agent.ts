// 从 User-Agent 读出浏览器与系统名,用于会话列表「Chrome on macOS」。识别不了时返回 null,由调用方显示通用文案。

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]

function first(table: readonly [RegExp, string][], value: string): string | null {
  return table.find(([pattern]) => pattern.test(value))?.[1] ?? null
}

export function describeUserAgent(userAgent: string | null): {
  browser: string | null
  os: string | null
} {
  if (!userAgent) return { browser: null, os: null }
  return { browser: first(BROWSERS, userAgent), os: first(SYSTEMS, userAgent) }
}
