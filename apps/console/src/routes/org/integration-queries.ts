// API key、Webhook 端点详情与投递记录的查询;列表、创建、轮换与删除沿用 queries.ts。

import type {
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import {
  queryKeyPrefixes,
  useApiInfiniteQuery,
  useApiMutation,
  useApiQuery,
} from '@xid-kit/web-ui/queries'
import { useIsTenantScopeOrg } from './useOrgTarget'
import type { ApiKey, V1Page, WebhookEndpoint } from './types'

export type ActorRef = {
  kind: 'user' | 'api_key'
  id: string
  displayName: string | null
}

export type ApiKeyRow = ApiKey & { createdBy: ActorRef | null }

export type GrantableScopes = {
  scopes: string[]
  fullAccess: boolean
}

export type WebhookStats7d = {
  sent: number
  delivered: number
  failed: number
  pending: number
}

export type WebhookDetail = WebhookEndpoint & {
  stats7d: WebhookStats7d
  createdBy: ActorRef | null
  secretRotatedAt: string
}

export type WebhookDeliveryStatus = 'delivered' | 'failed' | 'pending'
export type WebhookDeliveryFilter = 'all' | 'failed' | 'pending'

export type WebhookDelivery = {
  id: string
  eventType: string
  summary: {
    userId: string | null
    userName: string | null
    organizationId: string | null
    organizationName: string | null
  }
  status: WebhookDeliveryStatus
  attemptCount: number
  maxAttempts: number
  responseStatus: number | null
  responseMs: number | null
  lastError: 'timeout' | 'network' | 'http' | null
  nextRetryAt: string | null
  createdAt: string
  deliveredAt: string | null
}

export type UpdateWebhookInput = {
  webhookId: string
  event_types?: string[]
  status?: 'active' | 'disabled'
}

export const DELIVERY_PAGE_SIZE = 50

export function useApiKeyRowsQuery(): UseInfiniteQueryResult<V1Page<ApiKeyRow>, XidError> {
  const isTenantScope = useIsTenantScopeOrg()
  return useApiInfiniteQuery<V1Page<ApiKeyRow>>(
    [...queryKeyPrefixes.apiKeys, 'rows'],
    '/v1/api-keys',
    {
      enabled: isTenantScope,
      query: { limit: 100 },
    },
  )
}

export function useGrantableScopesQuery(
  enabled: boolean,
): UseQueryResult<GrantableScopes, XidError> {
  const isTenantScope = useIsTenantScopeOrg()
  return useApiQuery<GrantableScopes>(
    [...queryKeyPrefixes.apiKeys, 'grantable-scopes'],
    '/v1/api-keys/grantable-scopes',
    { enabled: isTenantScope && enabled },
  )
}

export function useWebhookDetailQuery(webhookId: string): UseQueryResult<WebhookDetail, XidError> {
  const isTenantScope = useIsTenantScopeOrg()
  return useApiQuery<WebhookDetail>(
    [...queryKeyPrefixes.webhooks, 'detail', webhookId],
    `/v1/webhooks/${encodeURIComponent(webhookId)}`,
    { enabled: isTenantScope && webhookId !== '' },
  )
}

export function useWebhookDeliveriesQuery(
  webhookId: string,
  filter: WebhookDeliveryFilter,
  cursor: string | null,
): UseQueryResult<V1Page<WebhookDelivery>, XidError> {
  const isTenantScope = useIsTenantScopeOrg()
  return useApiQuery<V1Page<WebhookDelivery>>(
    [...queryKeyPrefixes.webhooks, 'deliveries', webhookId, filter, cursor],
    `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
    {
      enabled: isTenantScope && webhookId !== '',
      query: {
        status: filter,
        limit: String(DELIVERY_PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      },
    },
  )
}

export function useUpdateWebhook(): UseMutationResult<
  WebhookEndpoint,
  XidError,
  UpdateWebhookInput
> {
  return useApiMutation<WebhookEndpoint, UpdateWebhookInput>(
    (api, { webhookId, ...payload }) =>
      api.patch<WebhookEndpoint>(`/v1/webhooks/${encodeURIComponent(webhookId)}`, payload),
    { invalidate: [queryKeyPrefixes.webhooks] },
  )
}
