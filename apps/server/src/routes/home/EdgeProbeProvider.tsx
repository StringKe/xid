// 全站 landing 边缘探针上下文:首页挂载时请求 /v1/edge 一次,各区块共享实测数据。

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { readEdgeProbePrefetch } from '../../lib/edge-probe-prefetch'
import { normalizeColo, type EdgeProbeApi, type EdgeProbeView } from './edge-probe-format'

type EdgeProbeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: EdgeProbeView }
  | { status: 'error' }

const EdgeProbeContext = createContext<EdgeProbeState>({ status: 'idle' })

export function EdgeProbeProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<EdgeProbeState>({ status: 'idle' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      const start = performance.now()
      try {
        const prefetched = readEdgeProbePrefetch()
        const body = prefetched
          ? await prefetched
          : ((await fetch('/v1/edge', { cache: 'no-store' }).then((res) =>
              res.ok ? res.json() : null,
            )) as EdgeProbeApi | null)
        if (!body || cancelled) {
          if (!cancelled) setState({ status: 'error' })
          return
        }
        const next: EdgeProbeState = {
          status: 'ready',
          data: {
            ...body,
            edgeRttMs: performance.now() - start,
            coloCode: normalizeColo(body.colo),
          },
        }
        globalThis.requestAnimationFrame(() => {
          if (!cancelled) setState(next)
        })
      } catch {
        if (!cancelled) setState({ status: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(() => state, [state])
  return <EdgeProbeContext.Provider value={value}>{children}</EdgeProbeContext.Provider>
}

export function useEdgeProbe(): EdgeProbeState {
  return useContext(EdgeProbeContext)
}

export function useEdgeProbeData(): EdgeProbeView | null {
  const state = useEdgeProbe()
  return state.status === 'ready' ? state.data : null
}
