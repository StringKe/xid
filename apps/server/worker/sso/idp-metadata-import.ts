// 入站 SAML 连接保存时导入 IdP metadata,失败当场返回 422,不把无法使用的地址留给每日刷新。

import { parseIdpMetadataXml } from '@xid-kit/saml'
import type { ParsedIdpMetadata } from '@xid-kit/saml'
import { isPublicHttpsUrl } from '../lib/validate'
import { metadataInvalid, readMetadataInput } from './metadata-source'

export type IdpMetadataFields = {
  idpEntityId: string
  idpSsoUrl: string
  idpSloUrl: string | null
  idpCertificates: string[]
}

function toFields(parsed: ParsedIdpMetadata): IdpMetadataFields {
  return {
    idpEntityId: parsed.entityId,
    idpSsoUrl: parsed.ssoUrl,
    idpSloUrl: parsed.sloUrl,
    idpCertificates: parsed.certificates,
  }
}

export async function importIdpMetadata(input: {
  url?: string | undefined
  xml?: string | undefined
}): Promise<IdpMetadataFields | null> {
  const source = await readMetadataInput({
    ...input,
    urlParam: 'idp_metadata_url',
    xmlParam: 'idp_metadata_xml',
  })
  if (!source) return null
  const parsed = parseIdpMetadataXml(source.xml)
  if (!parsed.ok) throw metadataInvalid(source.paramName, new Error(parsed.error.reason))
  const { ssoUrl, sloUrl } = parsed.value
  if (!isPublicHttpsUrl(ssoUrl) || (sloUrl !== null && !isPublicHttpsUrl(sloUrl))) {
    throw metadataInvalid(source.paramName)
  }
  return toFields(parsed.value)
}
