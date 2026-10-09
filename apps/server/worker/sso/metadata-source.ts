// 管理员保存 SAML 连接或出站应用时同步读取 metadata:按 URL 拉取或直接使用上传的 XML。

import { AppError } from '../lib/errors'
import { isPublicHttpsUrl } from '../lib/validate'

export const SAML_METADATA_MAX_BYTES = 1024 * 1024
const SAML_METADATA_FETCH_TIMEOUT_MS = 10_000

export type MetadataInput = {
  url?: string | undefined
  xml?: string | undefined
  urlParam: string
  xmlParam: string
}

function invalid(paramName: string, cause?: unknown): AppError {
  return new AppError('validation_failed', { httpStatus: 422, meta: { paramName }, cause })
}

async function readBoundedText(response: Response, paramName: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > SAML_METADATA_MAX_BYTES) throw invalid(paramName)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > SAML_METADATA_MAX_BYTES) {
      await reader.cancel()
      throw invalid(paramName)
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function fetchMetadataXml(url: string, paramName: string): Promise<string> {
  if (!isPublicHttpsUrl(url)) throw invalid(paramName)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(SAML_METADATA_FETCH_TIMEOUT_MS),
    })
  } catch (cause) {
    throw invalid(paramName, cause)
  }
  if (!response.ok) throw invalid(paramName, new Error(`metadata http ${response.status}`))
  return readBoundedText(response, paramName)
}

// 返回 null 表示本次请求没有提供 metadata;URL 与 XML 同时提供时拒绝,避免两个来源不一致。
export async function readMetadataInput(
  input: MetadataInput,
): Promise<{ xml: string; paramName: string } | null> {
  if (input.url !== undefined && input.xml !== undefined) throw invalid(input.xmlParam)
  if (input.xml !== undefined) return { xml: input.xml, paramName: input.xmlParam }
  if (input.url !== undefined) {
    return { xml: await fetchMetadataXml(input.url, input.urlParam), paramName: input.urlParam }
  }
  return null
}

export function metadataInvalid(paramName: string, cause?: unknown): AppError {
  return invalid(paramName, cause)
}
