// 新 passkey 的默认名称:浏览器 + 操作系统,便于在列表里区分不同设备;识别不出时由调用方给通用名。

type UserAgentData = { platform?: string }

const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone|iPad|iPod/u, 'iOS'],
  [/Android/u, 'Android'],
  [/Mac OS X|Macintosh/u, 'macOS'],
  [/Windows/u, 'Windows'],
  [/CrOS/u, 'ChromeOS'],
  [/Linux/u, 'Linux'],
]

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg\//u, 'Edge'],
  [/Firefox\//u, 'Firefox'],
  [/OPR\//u, 'Opera'],
  [/Chrome\//u, 'Chrome'],
  [/Safari\//u, 'Safari'],
]

function match(source: string, table: ReadonlyArray<[RegExp, string]>): string | null {
  return table.find(([pattern]) => pattern.test(source))?.[1] ?? null
}

export function detectDeviceParts(): { browser: string; platform: string } | null {
  if (typeof navigator === 'undefined') return null
  const userAgent = navigator.userAgent
  const hinted = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
  const platform = hinted?.platform || match(userAgent, PLATFORMS)
  const browser = match(userAgent, BROWSERS)
  if (!platform || !browser) return null
  return { browser, platform }
}
