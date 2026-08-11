// SPA 单例 QueryClient:非 0 staleTime 避免 Hosted UI 关键路径挂载即重复回源。

import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // 401/403 已由 api client 归一为 XidError,盲目重试拖慢失败反馈。
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
