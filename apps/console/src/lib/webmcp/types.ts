// WebMCP 实验 API 最小类型(Chrome origin trial);无第三方类型包。

export type WebMcpJsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: readonly string[]
}

export type WebMcpToolAnnotations = {
  readOnlyHint?: boolean
  untrustedContentHint?: boolean
}

export type WebMcpToolDefinition = {
  name: string
  description: string
  inputSchema: WebMcpJsonSchema
  execute: (input: Record<string, unknown>) => Promise<unknown>
  annotations?: WebMcpToolAnnotations
}

export type WebMcpRegisterOptions = {
  signal?: AbortSignal
}

export type WebMcpModelContext = {
  registerTool: (tool: WebMcpToolDefinition, options?: WebMcpRegisterOptions) => void
}

export type WebMcpDocument = Document & {
  modelContext?: WebMcpModelContext
}
