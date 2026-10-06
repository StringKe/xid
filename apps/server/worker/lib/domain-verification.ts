export type DomainVerificationRecord = {
  type: 'TXT'
  name: string
  value: string
}

// Console、Management API 与每日 cron 校验共用同一份 TXT 记录名和值。
export function domainVerificationRecord(domain: string, token: string): DomainVerificationRecord {
  return {
    type: 'TXT',
    name: `_xid.${domain.replace(/^\*\./, '')}`,
    value: `xid-verify=${token}`,
  }
}
