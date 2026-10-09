// 出站 SAML IdP 的错误状态 Response(SAML Core 3.2.2.2):不含断言,用与 Success Response 相同的 SP 签名证书签 Response。

import { signSamlStatusResponse } from '@xid-kit/saml'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import type { SamlServiceProvider } from './outbound-saml-shared'
import { importSamlSigningKey, loadSigningCert } from './outbound-saml-signing'

export { SAML_STATUS } from '@xid-kit/saml'

export async function buildSignedSamlStatusResponse(
  c: Context<XidHonoEnv>,
  input: {
    sp: SamlServiceProvider
    issuer: string
    inResponseTo: string | undefined
    topLevelStatus: string
    secondLevelStatus: string
  },
): Promise<string> {
  const cert = await loadSigningCert(c, input.sp)
  const key = await importSamlSigningKey(cert, c.env.KEK)
  const signed = await signSamlStatusResponse(
    {
      issuer: input.issuer,
      destination: input.sp.acsUrl,
      topLevelStatus: input.topLevelStatus,
      secondLevelStatus: input.secondLevelStatus,
      ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
    },
    key,
  )
  if (!signed.ok) {
    throw new AppError('internal_error', {
      httpStatus: 500,
      longMessage: 'outbound_saml_status_sign_failed',
      cause: signed.error,
    })
  }
  return signed.value.samlResponse
}
