// 首页 head 内联脚本启动的边缘探针预取(与 EdgeProbeProvider 共享)。

import type { EdgeProbeApi } from '../routes/home/edge-probe-format'

export type EdgeProbePrefetch = Promise<EdgeProbeApi | null>

declare global {
  interface Window {
    __XID_EDGE_PROBE__?: EdgeProbePrefetch
  }
}

export function readEdgeProbePrefetch(): EdgeProbePrefetch | null {
  if (typeof window === 'undefined') return null
  return window.__XID_EDGE_PROBE__ ?? null
}
