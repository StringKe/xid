// TanStack Query 客户端(SPA 单例)。
// 读类数据(/v1/me、列表、详情)统一走 useQuery,写走 useMutation,缓存/失效经 queryClient,
// 替代手写 RemoteData/loading 三态(见 routes/org/useApiGet 旧模式)。
// staleTime 给一个非 0 默认,避免 Hosted UI 关键路径在挂载即重复回源(边缘速度可感知,见 PRODUCT)。

import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 30s 内视为新鲜,不自动 refetch;cookie 会话/列表数据这个窗口足够。
      staleTime: 30_000,
      // 401/403 等已被 api client 归一为 XidError;盲目重试无意义且拖慢失败反馈。
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
