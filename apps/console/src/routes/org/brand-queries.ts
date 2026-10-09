// 品牌草稿与发布、邮件域名立即检查、登录域名的接口形状与 hooks。

import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import type { OrgBranding, Result, XidError } from '@xid-kit/types'
import {
  queryKeys,
  useApiInfiniteQuery,
  useApiMutation,
  useApiQuery,
} from '@xid-kit/web-ui/queries'
import type { OrgDomain, V1Page } from './types'
import { useCanManageOrg } from './useOrgTarget'

export type BrandingActor = { kind: 'user' | 'api_key'; id: string; displayName: string | null }

export type BrandingEnvelope = {
  published: OrgBranding
  draft: OrgBranding | null
  draftUpdatedAt: string | null
  publishedAt: string | null
  publishedBy: BrandingActor | null
  hasUnpublishedChanges: boolean
  signInHost: string
}

export type LogoVariant = 'light' | 'dark'

export function useBrandingQuery(orgId: string): UseQueryResult<BrandingEnvelope, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<BrandingEnvelope>(
    queryKeys.orgBranding(orgId),
    `/v1/organizations/${orgId}/branding`,
    { enabled: canManage },
  )
}

function useSetBrandingCache(orgId: string): (envelope: BrandingEnvelope) => void {
  const queryClient = useQueryClient()
  return (envelope) => queryClient.setQueryData(queryKeys.orgBranding(orgId), envelope)
}

export function useSaveBrandingDraft(
  orgId: string,
): UseMutationResult<BrandingEnvelope, XidError, Partial<OrgBranding>> {
  const setCache = useSetBrandingCache(orgId)
  return useApiMutation<BrandingEnvelope, Partial<OrgBranding>>(
    (api, payload) => api.patch<BrandingEnvelope>(`/v1/organizations/${orgId}/branding`, payload),
    { onSuccess: setCache },
  )
}

export function usePublishBranding(
  orgId: string,
): UseMutationResult<BrandingEnvelope, XidError, void> {
  const setCache = useSetBrandingCache(orgId)
  return useApiMutation<BrandingEnvelope, void>(
    (api) => api.post<BrandingEnvelope>(`/v1/organizations/${orgId}/branding/publish`),
    { onSuccess: setCache },
  )
}

type LogoUploadResponse = { logo_url: string; variant: LogoVariant; branding: BrandingEnvelope }

// 共享 API client 只发 JSON,logo 走 multipart,同源 cookie 会话。
async function uploadLogo(
  orgId: string,
  input: { variant: LogoVariant; file: File },
): Promise<Result<LogoUploadResponse>> {
  const form = new FormData()
  form.set('file', input.file)
  const response = await fetch(
    `/v1/organizations/${encodeURIComponent(orgId)}/logo?variant=${input.variant}`,
    { method: 'PUT', body: form, credentials: 'include', headers: { Accept: 'application/json' } },
  )
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok) return { ok: true, value: body as LogoUploadResponse }
  const error = (body ?? {}) as Partial<XidError>
  return {
    ok: false,
    error: {
      code: error.code ?? 'server_error',
      message: '',
      httpStatus: response.status,
      ...(error.meta ? { meta: error.meta } : {}),
    },
  }
}

export function useUploadBrandLogo(
  orgId: string,
): UseMutationResult<LogoUploadResponse, XidError, { variant: LogoVariant; file: File }> {
  const setCache = useSetBrandingCache(orgId)
  return useApiMutation<LogoUploadResponse, { variant: LogoVariant; file: File }>(
    (_api, input) => uploadLogo(orgId, input),
    { onSuccess: (data) => setCache(data.branding) },
  )
}

export type DomainActor = { kind: 'user' | 'api_key'; id: string; display_name: string | null }

export type EmailDomain = OrgDomain & {
  verification_token: string
  created_at: string
  last_checked_at: string | null
  last_check_result: 'found' | 'not_found' | null
  user_count: number
  routed_connection: { id: string; name: string | null } | null
  added_by: DomainActor | null
}

export function useEmailDomainsQuery(
  orgId: string,
): UseInfiniteQueryResult<V1Page<EmailDomain>, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiInfiniteQuery<V1Page<EmailDomain>>(
    queryKeys.orgDomains(orgId),
    `/v1/organizations/${orgId}/domains`,
    { enabled: canManage, query: { limit: 50 } },
  )
}

// 检查结果直接写回列表缓存,展开的行不因重新拉取而折叠。
export function useCheckEmailDomain(
  orgId: string,
): UseMutationResult<EmailDomain, XidError, string> {
  const queryClient = useQueryClient()
  return useApiMutation<EmailDomain, string>(
    (api, domainId) =>
      api.post<EmailDomain>(
        `/v1/organizations/${orgId}/domains/${encodeURIComponent(domainId)}/verify`,
      ),
    {
      onSuccess: (updated) => {
        queryClient.setQueryData<InfiniteData<V1Page<EmailDomain>>>(
          queryKeys.orgDomains(orgId),
          (data) =>
            data
              ? {
                  ...data,
                  pages: data.pages.map((page) => ({
                    ...page,
                    data: page.data.map((row) => (row.id === updated.id ? updated : row)),
                  })),
                }
              : data,
        )
      },
    },
  )
}

export type DnsRecord = { type: string; name: string; value: string }

export type CustomHostname = {
  id: string
  organization_id: string
  hostname: string
  status: string
  hostname_status: string
  ssl_status: string | null
  ownership_expires_at: string | null
  activated_at: string | null
  last_polled_at: string | null
  requires_passkey_reregistration: boolean
  affected_passkey_user_count: number
  dns_checks: { txt: 'found' | 'pending' | 'not_required'; cname: 'found' | 'pending' }
  dns_records: {
    ownership: DnsRecord | null
    dcv_delegation: DnsRecord[]
    certificate_validation: DnsRecord[]
    traffic: DnsRecord
  }
  verification_errors: string[]
}

export type DeletedCustomHostname = { id: string; status: 'deleted'; remove_dns_record: DnsRecord }

function customHostnamesKey(orgId: string) {
  return ['organizations', orgId, 'custom-hostnames'] as const
}

export function useCustomHostnamesQuery(
  orgId: string,
): UseQueryResult<V1Page<CustomHostname>, XidError> {
  const canManage = useCanManageOrg(orgId)
  return useApiQuery<V1Page<CustomHostname>>(
    customHostnamesKey(orgId),
    `/v1/organizations/${orgId}/custom-hostnames`,
    { enabled: canManage, query: { limit: 100 } },
  )
}

export function useCreateCustomHostname(
  orgId: string,
): UseMutationResult<CustomHostname, XidError, { hostname: string }> {
  return useApiMutation<CustomHostname, { hostname: string }>(
    (api, payload) =>
      api.post<CustomHostname>(`/v1/organizations/${orgId}/custom-hostnames`, payload),
    { invalidate: [customHostnamesKey(orgId)] },
  )
}

export function useRefreshCustomHostname(
  orgId: string,
): UseMutationResult<CustomHostname, XidError, string> {
  return useApiMutation<CustomHostname, string>(
    (api, id) =>
      api.post<CustomHostname>(`/v1/organizations/${orgId}/custom-hostnames/${id}/refresh`),
    { invalidate: [customHostnamesKey(orgId)] },
  )
}

export function useDeleteCustomHostname(
  orgId: string,
): UseMutationResult<DeletedCustomHostname, XidError, string> {
  return useApiMutation<DeletedCustomHostname, string>(
    (api, id) =>
      api.del<DeletedCustomHostname>(`/v1/organizations/${orgId}/custom-hostnames/${id}`),
    { invalidate: [customHostnamesKey(orgId)] },
  )
}
