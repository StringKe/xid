import { AppError } from './lib/errors'

const COMPLIANCE_STORAGE_PREFIX = 'compliance/'
const MAX_COMPLIANCE_ARTIFACT_BYTES = 10 * 1024 * 1024
const SHA256_CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/u

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

export function isComplianceStorageKey(value: string): boolean {
  if (!value.startsWith(COMPLIANCE_STORAGE_PREFIX) || value.length > 1_024) return false
  const relative = value.slice(COMPLIANCE_STORAGE_PREFIX.length)
  return (
    relative.length > 0 &&
    !relative.startsWith('/') &&
    !relative.endsWith('/') &&
    !relative.includes('//') &&
    !relative.includes('..') &&
    !relative.includes('\\') &&
    !hasControlCharacter(relative)
  )
}

export function isComplianceChecksum(value: string): boolean {
  return SHA256_CHECKSUM_PATTERN.test(value)
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function artifactFilename(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 96)
  return `${base || 'compliance-document'}.pdf`
}

export async function complianceArtifactResponse(
  env: Env,
  document: {
    title: string
    storageKey: string | null
    checksum: string | null
  },
): Promise<Response> {
  if (
    !document.storageKey ||
    !document.checksum ||
    !isComplianceStorageKey(document.storageKey) ||
    !isComplianceChecksum(document.checksum)
  ) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  const object = await env.STORAGE.get(document.storageKey)
  if (!object) throw new AppError('not_found', { httpStatus: 404 })
  if (object.size > MAX_COMPLIANCE_ARTIFACT_BYTES) {
    throw new AppError('temporarily_unavailable', { httpStatus: 503 })
  }
  const bytes = await object.arrayBuffer()
  const digest = `sha256:${bytesToHex(await crypto.subtle.digest('SHA-256', bytes))}`
  if (digest !== document.checksum) {
    throw new AppError('temporarily_unavailable', { httpStatus: 503 })
  }
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${artifactFilename(document.title)}"`,
    'Content-Length': String(bytes.byteLength),
    'Content-Type': object.httpMetadata?.contentType ?? 'application/pdf',
    'X-Content-SHA256': digest,
    'X-Content-Type-Options': 'nosniff',
  })
  return new Response(bytes, { headers })
}
