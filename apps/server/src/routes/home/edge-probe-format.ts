// Landing 边缘探针展示格式化(纯函数,无 I/O)。

export type EdgeProbeApi = {
  colo: string | null
  tlsVersion: string | null
  tlsCipher: string | null
  verifyUs: number
  signingAlg: string
  accessTokenTtlSec: number
  jwksRoundTrips: number
}

export type EdgeProbeView = EdgeProbeApi & {
  edgeRttMs: number
  coloCode: string | null
}

export function normalizeColo(colo: string | null | undefined): string | null {
  const code = colo?.trim().toUpperCase()
  return code && code.length > 0 ? code : null
}

export function formatTlsLabel(tlsVersion: string | null): string | null {
  if (!tlsVersion) return null
  const match = /^TLSv?(\d(?:\.\d)?)$/i.exec(tlsVersion)
  if (match) return `TLS ${match[1]}`
  return tlsVersion
}

export function formatEdgeRtt(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)}ms`
  return `${Math.round(ms)}ms`
}

export function formatVerifyMicros(us: number): string {
  return `${us}µs`
}

export function formatTokenWindow(sec: number): string {
  return `${sec}s`
}

export function formatRoundTrips(count: number): string {
  return String(count)
}
