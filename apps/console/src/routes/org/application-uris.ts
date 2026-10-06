// 与服务端 web 应用的 redirect_uri 规则一致:绝对 https URL,不含凭据和 fragment。
export function isWebRedirectUri(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && url.hash === ''
  } catch {
    return false
  }
}

export function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function parseScopes(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
}
