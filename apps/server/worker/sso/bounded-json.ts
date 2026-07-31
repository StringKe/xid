// Bounded JSON reader for enterprise SSO outbound calls.
// Response bodies are streamed and capped before JSON parsing so an upstream cannot force an
// unbounded allocation in the Worker isolate.

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
      throw new Error('upstream response exceeds configured limit')
    }
  }

  if (!response.body) throw new Error('upstream response body is missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('upstream response exceeds configured limit')
    }
    chunks.push(part.value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
