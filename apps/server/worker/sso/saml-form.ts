// SAML SP 入站 binding 的形状校验:ACS / SLO 的表单与 query schema、RelayState 与 base64 XML 长度上限。

import * as v from 'valibot'
import { AppError } from '../lib/errors'

// RelayState 最大 2KB(超长截断记日志,见第 1 节决策)。
export const RELAY_STATE_MAX = 2048

// base64 XML 上限(字符数):schema 层拒超大 SAMLResponse/SAMLRequest,量级对齐 SAML_METADATA_MAX_BYTES。
const SAML_XML_BASE64_MAX_LENGTH = 256 * 1024

// HTTP-POST binding 的 ACS/SLO 表单:SAMLResponse/SAMLRequest 必填,RelayState 可选。
// FormData 值可能是 File,valibot string 直接拒(形状层),不用手写 typeof 守卫。
export const acsFormSchema = v.object({
  SAMLResponse: v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
  RelayState: v.optional(v.string()),
})

export const sloPostFormSchema = v.object({
  SAMLRequest: v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
  RelayState: v.optional(v.string()),
})

// HTTP-Redirect binding 的 SLO query 必须携带 detached Signature/SigAlg。
export const sloRedirectQuerySchema = v.object({
  SAMLRequest: v.pipe(v.string(), v.minLength(1), v.maxLength(SAML_XML_BASE64_MAX_LENGTH)),
  RelayState: v.optional(v.pipe(v.string(), v.maxLength(RELAY_STATE_MAX))),
  Signature: v.optional(v.pipe(v.string(), v.minLength(1))),
  SigAlg: v.optional(v.pipe(v.string(), v.minLength(1))),
})

// SSO 协议面错误契约是 malformed_request 400(8.8),不走 validation_failed 422,故此处用
// safeParse 自行映射而不调 validateBody。
export function parseShape<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input)
  if (!result.success) throw new AppError('malformed_request', { httpStatus: 400 })
  return result.output
}
